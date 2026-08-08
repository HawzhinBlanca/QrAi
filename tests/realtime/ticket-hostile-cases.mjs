const NUL = String.fromCharCode(0);

/**
 * One language-neutral hostile ticket corpus executed against both the deployed Rust oracle and
 * the Node admission shadow. `validTicket` must mint with the implementation-independent rt_v2
 * contract; only the named mutations below are authored here.
 */
export function buildHostileTicketCases({
  validTicket,
  sessionId,
  tenantId,
  learnerId,
  nowUnixSeconds,
}) {
  if (typeof validTicket !== "function") throw new TypeError("validTicket must be a function");
  for (const [name, value] of Object.entries({ sessionId, tenantId, learnerId })) {
    if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  }
  if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds < 0) {
    throw new TypeError("nowUnixSeconds must be a non-negative safe integer");
  }

  const signed = "0".repeat(64);
  return Object.freeze([
    ["empty", ""],
    ["wrong prefix", "hello"],
    ["too few parts", "rt_v2.a.b"],
    ["too many parts", `${validTicket()}.extra.parts`],
    ["100 000 characters", `rt_v2.${"x".repeat(100_000)}`],
    ["a NUL byte", `rt_v2.a.b.c.true.discard.1.n.${NUL}`],
    ["negative expiry", `rt_v2.${sessionId}.${tenantId}.${learnerId}.false.discard.-1.n.${signed}`],
    ["non-numeric expiry", `rt_v2.${sessionId}.${tenantId}.${learnerId}.false.discard.abc.n.${signed}`],
    ["non-boolean consent", `rt_v2.${sessionId}.${tenantId}.${learnerId}.maybe.discard.${nowUnixSeconds + 300}.n.${signed}`],
    ["blank retention", `rt_v2.${sessionId}.${tenantId}.${learnerId}.false..${nowUnixSeconds + 300}.n.${signed}`],
    ["short signature", `rt_v2.${sessionId}.${tenantId}.${learnerId}.false.discard.${nowUnixSeconds + 300}.n.ab`],
    ["non-hex signature", `rt_v2.${sessionId}.${tenantId}.${learnerId}.false.discard.${nowUnixSeconds + 300}.n.${"z".repeat(64)}`],
    ["a pre-retention v1 ticket", `rt_v1.${sessionId}.${tenantId}.${learnerId}.false.${nowUnixSeconds + 300}.n.${signed}`],
    ["another tenant", validTicket({ tenantId: "tenant-somebody-else" })],
    ["another session", validTicket({ sessionId: "session-somebody-else" })],
  ].map(([name, ticket]) => Object.freeze({ name, ticket })));
}
