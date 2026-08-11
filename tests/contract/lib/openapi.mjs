/**
 * F1/F2 — shared helpers for the contract layer.
 * specs/flutter-client/plan.md
 */
import { readFileSync } from "node:fs";

import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

export function loadOpenapi(path) {
  const doc = parse(readFileSync(path, "utf8"));
  if (doc.openapi !== "3.1.0") {
    throw new Error(`expected OpenAPI 3.1.0, got ${doc.openapi}`);
  }
  return doc;
}

/**
 * Enumerate the routes the service actually registers.
 *
 * Splits on `.route("` and takes the verbs registered before the NEXT builder call, so a path with
 * several methods (`/v1/learner/progress` has GET and POST on separate registrations) yields one
 * pair each rather than collapsing.
 */
export function routePairsFromRust(src) {
  const pairs = [];
  // A REGEX, not the literal `.route("`: most registrations in lib.rs are multi-line, with the path
  // on the line after `.route(`. Splitting on the literal found 4 of 34 and the coverage test read
  // that as "the contract describes 30 routes that do not exist".
  // `(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*` — whitespace OR COMMENTS between `.route(` and the path.
  // Two registrations put an ADR-0037 note there, and `\s*` alone did not match a comment, so the
  // split walked straight past them: GET /v1/tajweed-findings/{id}/audio and POST /v1/audio-chunks
  // were invisible. Nothing failed, because coverage.test.mjs compares THIS parser's output to the
  // contract and the contract was missing exactly the same two — both sides agreed on a smaller
  // world. That is the second time this parser has silently under-counted (34 of 38, above); the
  // difference is that an under-count here does not just report a wrong number, it makes a route
  // unreachable by every check that starts from this list.
  for (const block of src.split(/\.route\((?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*"/).slice(1)) {
    const path = block.split('"', 1)[0];
    const tail = block.split(/\.route\(|\.layer\(|\.with_state|\.fallback/, 1)[0];
    // TWO forms, and missing the second is a silent under-count:
    //   axum::routing::get(h)              the first method on a path
    //   axum::routing::get(h).post(h2)     every SUBSEQUENT method, CHAINED on the MethodRouter
    // Matching only the first form found 34 pairs where there are 38 — and Phase 7's research used
    // that same pattern, so its "34 method+path pairs" was four short. Corrected in
    // specs/flutter-client/tasks.md rather than left to propagate.
    // THREE forms now. The third is a BARE `get(handler)`, which is how services/realtime-gateway
    // registers — it imports the verbs. Requiring `axum::routing::` or a leading `.` made this
    // parser return ZERO routes for a real router, silently: a caller pointing it at the gateway
    // got an empty list and no error. `(?<![\w.])` keeps that from matching `map.get(` or an
    // identifier ending in the verb, and the tail is already bounded to this registration.
    for (const verb of tail.matchAll(/(?:axum::routing::|\.|(?<![\w.:]))(get|post|put|patch|delete)\s*\(/g)) {
      pairs.push({ method: verb[1].toUpperCase(), path });
    }
  }
  // Deduplicate: identical method+path registered twice would otherwise inflate the count.
  const seen = new Set();
  return pairs.filter((p) => {
    const k = `${p.method} ${p.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Follow a RESPONSE-LEVEL `$ref` to the Response Object it names.
 *
 * OpenAPI allows a whole Response Object to be a reference — `'403': { $ref:
 * '#/components/responses/Forbidden' }` — and every error response in this contract is written that
 * way (50 of them: 400/401/403/404). `compileResponseValidators` used to read
 * `res.content["application/json"].schema` straight off that object, find `undefined`, and `continue`.
 * So no validator was ever compiled for a single error response, and the two consumers reported it
 * as an absence rather than a miss: the fixture validator counted them under "skipped (no schema)"
 * while printing a clean pass, and `assertMatchesContract` — which is careful enough to fail loudly
 * on a missing entry — would have refused any parity test that tried to assert a 403 body.
 * Confirmed by replacing `components.schemas.Error` with an incompatible type: the run was
 * byte-identical.
 *
 * THROWS on a ref that does not resolve, and on any ref shape other than a local pointer into
 * `#/components/responses/`. A resolver that returns undefined for a ref it cannot follow would
 * restore exactly the silent skip this fixes — the caller cannot tell "no schema contracted" from
 * "schema contracted, resolver gave up".
 */
export function derefResponse(spec, res, where) {
  const ref = res?.$ref;
  if (typeof ref !== "string") return res;

  const prefix = "#/components/responses/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`${where}: unsupported response $ref ${ref} — expected ${prefix}<Name>`);
  }
  const name = ref.slice(prefix.length);
  const target = spec.components?.responses?.[name];
  if (!target) throw new Error(`${where}: response $ref ${ref} resolves to nothing`);
  // One hop only: a components/responses entry that itself is a $ref is not something this contract
  // uses, and quietly chasing a chain would hide a circular one as a hang.
  if (target.$ref) throw new Error(`${where}: response $ref ${ref} points at another $ref`);
  return target;
}

/**
 * Compile every response schema in the document into an ajv validator.
 *
 * `strict: false` because an OpenAPI document legitimately carries keywords ajv does not know
 * (`example`, `x-unvalidated`, `summary`), and refusing them would mean stripping the spec rather
 * than validating against it.
 */
export function compileResponseValidators(spec) {
  const ajv = new Ajv.default({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats.default(ajv);

  const validators = new Map();
  /**
   * `#/components/schemas/X` is a JSON Pointer from the ROOT OF THE SCHEMA DOCUMENT, so the fix is
   * to make each compiled schema's root carry `components` — not to rewrite the refs.
   *
   * The first attempt registered components under `$id: "components"` and rewrote refs to
   * `components#/…`, which failed: the registered blob still held ORIGINAL-form refs internally
   * (RecitationSession -> #/components/schemas/QuranRef), so nested resolution broke.
   */
  const resolve = (schema) => ({ ...schema, components: spec.components });

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      for (const [status, ref] of Object.entries(op.responses ?? {})) {
        const res = derefResponse(spec, ref, `${method.toUpperCase()} ${path} ${status}`);
        const schema = res?.content?.["application/json"]?.schema;
        if (!schema) continue;
        const key = `${method.toUpperCase()} ${path} ${status}`;
        try {
          validators.set(key, {
            validate: ajv.compile(resolve(schema)),
            unvalidated: op["x-unvalidated"] === true,
          });
        } catch (err) {
          throw new Error(`cannot compile schema for ${key}: ${err.message}`);
        }
      }
    }
  }
  return validators;
}

/** Turn a concrete request path into the OpenAPI template it matches, or null. */
export function templateFor(spec, method, concretePath) {
  const want = concretePath.split("?")[0].replace(/\/+$/, "") || "/";
  const segs = want.split("/");
  for (const path of Object.keys(spec.paths)) {
    if (!spec.paths[path][method.toLowerCase()]) continue;
    const t = path.split("/");
    if (t.length !== segs.length) continue;
    if (t.every((s, i) => (s.startsWith("{") && s.endsWith("}")) || s === segs[i])) return path;
  }
  return null;
}
