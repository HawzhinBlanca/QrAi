/**
 * The strangler's forwarding half. Extracted from `server.mjs` by N7 so that a ported handler can
 * *also* delegate — `resolveActor` returns `{ delegate }` for the pilot-cookie path, and every
 * ported route needs to hand those requests to Rust rather than half-authenticate them.
 *
 * specs/migration-completion/plan.md §2 (N7)
 */

import { ApiError } from "./authz.mjs";
import { fetchWithDeadline } from "./deadline.mjs";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Forward a request upstream and copy the response back verbatim.
 *
 * Verbatim is the whole contract: status, body BYTES, and every response header except the
 * hop-by-hop ones. Set-Cookie in particular must survive with its attributes intact — the
 * `__Host-qrai-pilot` cookie's Secure/HttpOnly/SameSite/Path are exactly what a careless proxy
 * drops, and nothing downstream would notice until a pilot learner's session broke.
 */
export async function proxy(req, reply, upstream) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }

  // ── The forwarding headers are OVERWRITTEN, not passed through ───────────────────────────────
  //
  // Not a hole in "verbatim": `HOP_BY_HOP` above already establishes that headers describing the
  // HOP are the proxy's to set, and X-Forwarded-For is the definitive example — an intermediary
  // writes it, a client does not get to.
  //
  // Without this, a request carrying `x-forwarded-for: 1.2.3.4` reached the upstream with
  // `x-forwarded-for: 1.2.3.4` and this service added nothing of its own. Both of platform-api's
  // rate-limiting configurations are wrong under such a proxy:
  //
  //   TRUST_PROXY_HEADERS=1  keys on the header, so a client picks its own bucket by setting one
  //                          header and the limiter stops existing. lib.rs:375 warns this is only
  //                          safe "behind a proxy that OVERWRITES those headers" — and this IS
  //                          that proxy.
  //   default (peer-keyed)   sees this process's address for every proxied request, collapsing all
  //                          proxied traffic into ONE bucket. One busy client throttles everyone.
  //
  // `req.ip` is Fastify's `trustProxy`-aware resolution — the SAME value `app.mjs` charges this
  // service's own token bucket (`rateLimiter.consume(req.ip)`), so both services key on the same
  // client and neither trusts anything the caller said beyond what `TRUSTED_PROXY_HOPS` allows.
  //
  // Ported from `services/node-api/lib/proxy.mjs` (#409), which passes the address as a fourth
  // argument its callers must remember to supply. Reading `req.ip` here needs no signature change
  // and cannot be forgotten by one of the fifteen call sites.
  if (req.ip) {
    headers["x-forwarded-for"] = req.ip;
    headers["x-real-ip"] = req.ip;
  }

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let upstreamRes;
  try {
    upstreamRes = await fetchWithDeadline(new URL(req.url, upstream), {
      deadline: req.deadline,
      method: req.method,
      headers,
      // req.body is already parsed by Fastify; re-serialize. `rawBody` would be better but needs a
      // content-type-agnostic parser, and every body this API accepts is JSON.
      body: hasBody && req.body !== undefined ? JSON.stringify(req.body) : undefined,
      redirect: "manual",
    });
  } catch {
    throw new ApiError("compatibility service unavailable", 502);
  }

  for (const [k, v] of upstreamRes.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === "set-cookie") continue;
    reply.header(k, v);
  }
  // getSetCookie() preserves MULTIPLE Set-Cookie headers; iterating headers collapses them into one
  // comma-joined value, which silently corrupts any cookie whose Expires attribute contains a comma.
  for (const c of upstreamRes.headers.getSetCookie()) reply.header("set-cookie", c);

  reply.code(upstreamRes.status);

  let body;
  try {
    body = Buffer.from(await upstreamRes.arrayBuffer());
  } catch {
    throw new ApiError("compatibility service unavailable", 502);
  }
  // Fastify stamps a content-type on any payload it serializes. Upstream responses that carry NONE
  // — the /metrics 404, empty error bodies — would come back with one invented by the proxy, which
  // the Phase 5 differ caught as `keys differ ... got [.., content-type]`. Send nothing at all when
  // there was nothing, so a header the origin never set is never manufactured.
  if (!upstreamRes.headers.has("content-type")) {
    reply.removeHeader("content-type");
    return body.length === 0 ? reply.send() : reply.send(body);
  }
  return reply.send(body);
}
