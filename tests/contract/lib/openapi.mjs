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

  // Rust permits comments between a call's opening parenthesis and its first argument. Treat those
  // comments as lexical trivia instead of trying to grow a route-matching regular expression.
  // Block comments may nest in Rust, so the scanner tracks depth.
  const skipTrivia = (start) => {
    let at = start;
    while (at < src.length) {
      if (/\s/.test(src[at])) {
        at += 1;
        continue;
      }
      if (src.startsWith("//", at)) {
        const newline = src.indexOf("\n", at + 2);
        at = newline === -1 ? src.length : newline + 1;
        continue;
      }
      if (src.startsWith("/*", at)) {
        let depth = 1;
        at += 2;
        while (at < src.length && depth > 0) {
          if (src.startsWith("/*", at)) {
            depth += 1;
            at += 2;
          } else if (src.startsWith("*/", at)) {
            depth -= 1;
            at += 2;
          } else {
            at += 1;
          }
        }
        continue;
      }
      break;
    }
    return at;
  };

  let cursor = 0;
  while (cursor < src.length) {
    const routeStart = src.indexOf(".route(", cursor);
    if (routeStart === -1) break;

    const pathStart = skipTrivia(routeStart + ".route(".length);
    if (src[pathStart] !== '"') {
      cursor = routeStart + ".route(".length;
      continue;
    }

    let pathEnd = pathStart + 1;
    while (pathEnd < src.length) {
      if (src[pathEnd] === "\\") {
        pathEnd += 2;
        continue;
      }
      if (src[pathEnd] === '"') break;
      pathEnd += 1;
    }
    if (pathEnd >= src.length) break;

    const path = src.slice(pathStart + 1, pathEnd);
    const tailStart = pathEnd + 1;
    const boundaryOffsets = [".route(", ".layer(", ".with_state", ".fallback"]
      .map((boundary) => src.indexOf(boundary, tailStart))
      .filter((offset) => offset !== -1);
    const tailEnd = boundaryOffsets.length === 0 ? src.length : Math.min(...boundaryOffsets);
    const tail = src.slice(tailStart, tailEnd);

    // TWO forms, and missing the second is a silent under-count:
    //   axum::routing::get(h)              the first method on a path
    //   axum::routing::get(h).post(h2)     every SUBSEQUENT method, CHAINED on the MethodRouter
    for (const verb of tail.matchAll(/(?:axum::routing::|\.)(get|post|put|patch|delete)\s*\(/g)) {
      pairs.push({ method: verb[1].toUpperCase(), path });
    }

    cursor = pathEnd + 1;
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
