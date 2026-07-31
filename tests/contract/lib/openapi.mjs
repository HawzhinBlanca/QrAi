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
  for (const block of src.split(/\.route\(\s*"/).slice(1)) {
    const path = block.split('"', 1)[0];
    const tail = block.split(/\.route\(|\.layer\(|\.with_state|\.fallback/, 1)[0];
    // TWO forms, and missing the second is a silent under-count:
    //   axum::routing::get(h)              the first method on a path
    //   axum::routing::get(h).post(h2)     every SUBSEQUENT method, CHAINED on the MethodRouter
    // Matching only the first form found 34 pairs where there are 38 — and Phase 7's research used
    // that same pattern, so its "34 method+path pairs" was four short. Corrected in
    // specs/flutter-client/tasks.md rather than left to propagate.
    for (const verb of tail.matchAll(/(?:axum::routing::|\.)(get|post|put|patch|delete)\s*\(/g)) {
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
      for (const [status, res] of Object.entries(op.responses ?? {})) {
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
