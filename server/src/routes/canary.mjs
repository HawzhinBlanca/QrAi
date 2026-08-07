import { readFileSync } from "node:fs";

export const RETAINED_CANARY_ROUTE_COUNT = 39;

function routeKey(operation) {
  if (
    !operation ||
    typeof operation !== "object" ||
    typeof operation.method !== "string" ||
    typeof operation.path !== "string"
  ) {
    throw new TypeError("route manifest operations require string method and path fields");
  }
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

export function retainedCanaryRouteKeys(manifest, routes) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("retained canary route manifest must be an object");
  }
  if (!Array.isArray(manifest.baselineOperations) || !Array.isArray(manifest.targetAdditions)) {
    throw new TypeError("retained canary route manifest is missing operation inventories");
  }
  if (!Array.isArray(routes)) {
    throw new TypeError("retained canary executable routes must be an array");
  }

  const selected = [
    ...manifest.baselineOperations
      .filter(({ target }) => target === "retain")
      .map(routeKey),
    ...manifest.targetAdditions
      .filter(({ implementationStatus }) => implementationStatus === "implemented-node")
      .map(routeKey),
  ];
  if (selected.length !== RETAINED_CANARY_ROUTE_COUNT) {
    throw new TypeError(
      `retained canary requires exactly ${RETAINED_CANARY_ROUTE_COUNT} operations; manifest selected ${selected.length}`,
    );
  }
  if (new Set(selected).size !== selected.length) {
    throw new TypeError("retained canary route manifest contains duplicate operations");
  }

  const executable = new Map(routes.map((route) => [route.key, route]));
  for (const key of selected) {
    const route = executable.get(key);
    if (!route) {
      throw new TypeError(`retained canary operation has no Node handler: ${key}`);
    }
    if (route.ownerGate !== undefined) {
      throw new TypeError(`retained canary operation is owner-gated: ${key}`);
    }
  }
  return selected;
}

export function loadRetainedCanaryRouteKeys(routes) {
  const manifestUrl = new URL("../../../packages/contracts/route-manifest.json", import.meta.url);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  } catch (error) {
    throw new TypeError(`unable to load retained canary route manifest: ${error.message}`);
  }
  return retainedCanaryRouteKeys(manifest, routes);
}
