export const RECOVERY_REPORT_STATES = Object.freeze(["complete", "degraded"]);
export const RECOVERY_STOP_REASONS = Object.freeze([
  "completed",
  "retry-exhausted",
  "buffer-overflow",
  "ack-ambiguous",
  "ack-invalid",
  "rejected-exhausted",
  "drain-timeout",
  "device-failure",
]);

const BODY_FIELDS = new Set(["recoveryReport"]);
const REPORT_FIELDS = new Set([
  "version",
  "state",
  "capturedChunks",
  "acknowledgedChunks",
  "droppedChunks",
  "uncertainChunks",
  "stopReason",
]);
const MAX_COUNT = 2_147_483_647;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new TypeError(`recovery report ${name} must be an integer from 0 through ${MAX_COUNT}`);
  }
  return value;
}

export function validateRecoveryReport(value) {
  if (!plainObject(value) || !exactKeys(value, REPORT_FIELDS)) {
    throw new TypeError("recovery report must contain only the exact versioned fields");
  }
  if (value.version !== 1) throw new TypeError("recovery report version must be 1");
  if (!RECOVERY_REPORT_STATES.includes(value.state)) {
    throw new TypeError("recovery report state is invalid");
  }
  if (!RECOVERY_STOP_REASONS.includes(value.stopReason)) {
    throw new TypeError("recovery report stop reason is invalid");
  }
  const report = Object.freeze({
    version: 1,
    state: value.state,
    capturedChunks: count(value.capturedChunks, "capturedChunks"),
    acknowledgedChunks: count(value.acknowledgedChunks, "acknowledgedChunks"),
    droppedChunks: count(value.droppedChunks, "droppedChunks"),
    uncertainChunks: count(value.uncertainChunks, "uncertainChunks"),
    stopReason: value.stopReason,
  });
  if (
    report.capturedChunks !==
      report.acknowledgedChunks + report.droppedChunks + report.uncertainChunks
  ) {
    throw new TypeError("recovery report chunk accounting is inconsistent");
  }
  if (
    report.state === "complete" &&
    (report.stopReason !== "completed" ||
      report.droppedChunks !== 0 ||
      report.uncertainChunks !== 0)
  ) {
    throw new TypeError("recovery report complete state cannot contain loss");
  }
  if (report.state === "degraded" && report.stopReason === "completed") {
    throw new TypeError("recovery report degraded state requires a failure reason");
  }
  return report;
}

export function validateRecoveryReportBody(body) {
  if (body === undefined || body === null) return null;
  if (!plainObject(body)) throw new TypeError("finalization request body must be an object");
  const keys = Object.keys(body);
  if (keys.length === 0) return null;
  if (!exactKeys(body, BODY_FIELDS)) {
    throw new TypeError("finalization request body may contain only recoveryReport");
  }
  return validateRecoveryReport(body.recoveryReport);
}

export function recoveryReportFromSessionRow(row) {
  if (row?.capture_report_version === null || row?.capture_report_version === undefined) return null;
  return validateRecoveryReport({
    version: Number(row.capture_report_version),
    state: row.capture_report_state,
    capturedChunks: Number(row.capture_total_chunks),
    acknowledgedChunks: Number(row.capture_acknowledged_chunks),
    droppedChunks: Number(row.capture_dropped_chunks),
    uncertainChunks: Number(row.capture_uncertain_chunks),
    stopReason: row.capture_stop_reason,
  });
}

export function recoveryReportsEqual(left, right) {
  if (left === null || right === null) return left === right;
  return [...REPORT_FIELDS].every((field) => left[field] === right[field]);
}

export function recoveryResponseFields(report, serverLostChunkCount) {
  const serverLost = count(serverLostChunkCount, "serverLostChunkCount");
  const selected = report === null ? null : validateRecoveryReport(report);
  const recordingStatus =
    serverLost > 0 || selected?.state === "degraded"
      ? "incomplete"
      : selected?.state === "complete"
        ? "complete"
        : "unverified";
  return Object.freeze({
    recordingStatus,
    clientDroppedChunkCount: selected?.droppedChunks ?? 0,
    clientUncertainChunkCount: selected?.uncertainChunks ?? 0,
    serverLostChunkCount: serverLost,
  });
}
