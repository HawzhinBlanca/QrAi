import { isDeepStrictEqual } from "node:util";

import { validateModelAttribution } from "../inference/model-attribution.mjs";
import { ApiError } from "./authz.mjs";

/** Validate a producer-authored model envelope without filling or rewriting any identity field. */
export function requireProducerAttribution(result, expectedComponent, label) {
  try {
    const attribution = validateModelAttribution(result?.modelAttribution, {
      legacyModelVersion: result?.modelVersion,
    });
    if (attribution.primaryComponent !== expectedComponent) {
      throw new Error(
        `expected primary component ${expectedComponent}, received ${attribution.primaryComponent}`,
      );
    }
    return attribution;
  } catch (error) {
    // Never log `result`: an ASR envelope contains a learner transcript.
    console.error(`${label} service returned invalid model attribution`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(`${label} service returned invalid model attribution`, 502);
  }
}

/**
 * Require a composed producer document to preserve every upstream component exactly and add only
 * the named downstream component. Both envelopes must be validated first by the caller.
 */
export function requireExactAttributionExtension(
  upstream,
  composed,
  downstreamComponent,
  label,
) {
  const invalid = () => {
    console.error(`${label} service returned a model attribution unrelated to its input`);
    throw new ApiError(`${label} service returned invalid model attribution`, 502);
  };

  const upstreamComponents = upstream?.modelAttribution?.components;
  const composedComponents = composed?.modelAttribution?.components;
  if (!Array.isArray(upstreamComponents) || !Array.isArray(composedComponents)) invalid();
  if (composedComponents.length !== upstreamComponents.length + 1) invalid();
  if (
    upstreamComponents.some(
      (component) => !composedComponents.some((candidate) => isDeepStrictEqual(candidate, component)),
    )
  ) {
    invalid();
  }
  if (
    composedComponents.filter((component) => component?.component === downstreamComponent).length !== 1
  ) {
    invalid();
  }
}
