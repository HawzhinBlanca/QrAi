import type { RecitationConsent } from "../lib/api";

export function ConsentPanel({
  consent,
  onConsentChange,
}: {
  consent: RecitationConsent;
  onConsentChange: (consent: RecitationConsent) => void;
}) {
  return (
    <div className="consent-panel" aria-label="Recording consent">
      <p className="quiet-label">Recording consent</p>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.audioRetention === "teacher-review"}
          onChange={(event) =>
            onConsentChange({
              ...consent,
              audioRetention: event.target.checked ? "teacher-review" : "discard",
            })
          }
        />
        <span>Keep my recitation for teacher review (otherwise it is discarded after analysis).</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.anonymizedLearning}
          onChange={(event) => onConsentChange({ ...consent, anonymizedLearning: event.target.checked })}
        />
        <span>Help improve the model with anonymized data.</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.externalAsrProcessing}
          onChange={(event) => onConsentChange({ ...consent, externalAsrProcessing: event.target.checked })}
        />
        <span>Allow browser or cloud speech processing if the local Quran ASR is unavailable.</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.guardianApproved}
          onChange={(event) => onConsentChange({ ...consent, guardianApproved: event.target.checked })}
        />
        <span>A parent/guardian approves this (required for learners under 13).</span>
      </label>
    </div>
  );
}
