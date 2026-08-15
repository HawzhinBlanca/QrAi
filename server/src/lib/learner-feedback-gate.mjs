const SHA256 = /^sha256:[a-f0-9]{64}$/;

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

export function clearsLearnerFeedbackGate(finding) {
  const approved =
    finding?.reviewStatus === "teacher-reviewed" || finding?.reviewStatus === "scholar-approved";
  const confidence = typeof finding?.confidence === "number" ? finding.confidence : Number.NaN;
  const sources = Array.isArray(finding?.sources) ? finding.sources : [];
  const validSources =
    sources.length > 0 &&
    sources.every(
      (source) =>
        source !== null &&
        typeof source === "object" &&
        nonEmpty(source.id) &&
        nonEmpty(source.title) &&
        nonEmpty(source.citation),
    );
  const validSpan =
    Number.isInteger(finding?.startMs) &&
    Number.isInteger(finding?.endMs) &&
    finding.startMs >= 0 &&
    finding.endMs > finding.startMs;
  const validIds = [
    finding?.evidenceId,
    finding?.modelVersion,
    finding?.acousticDatasetVersion,
    finding?.calibratorId,
    finding?.evaluationEvidenceId,
    finding?.auditEventId,
  ].every(nonEmpty);
  const validDigests = [
    finding?.modelArtifactSha256,
    finding?.acousticDatasetManifestSha256,
    finding?.calibratorArtifactSha256,
    finding?.evaluationEvidenceSha256,
  ].every((value) => typeof value === "string" && SHA256.test(value));

  return (
    finding?.analysisBasis === "acoustic" &&
    approved &&
    Number.isFinite(confidence) &&
    confidence >= 0.82 &&
    confidence <= 1 &&
    validSources &&
    finding?.withheld === false &&
    validSpan &&
    finding?.audioStatus === "available" &&
    validIds &&
    validDigests &&
    finding?.calibrationStatus === "calibrated" &&
    finding?.evaluationEvidenceStatus === "release-trusted"
  );
}
