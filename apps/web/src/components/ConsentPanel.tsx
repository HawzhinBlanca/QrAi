import { useTranslation } from "react-i18next";
import type { RecitationConsent } from "../lib/api";

export function ConsentPanel({
  consent,
  onConsentChange,
}: {
  consent: RecitationConsent;
  onConsentChange: (consent: RecitationConsent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="consent-panel" aria-label={t("consent.ariaLabel")}>
      <p className="quiet-label">{t("consent.title")}</p>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.recordingConsent}
          onChange={(event) => onConsentChange({ ...consent, recordingConsent: event.target.checked })}
        />
        <span>{t("consent.recordingConsent")}</span>
      </label>
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
        <span>{t("consent.teacherReview")}</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.anonymizedLearning}
          onChange={(event) => onConsentChange({ ...consent, anonymizedLearning: event.target.checked })}
        />
        <span>{t("consent.anonymizedLearning")}</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.externalAsrProcessing}
          onChange={(event) => onConsentChange({ ...consent, externalAsrProcessing: event.target.checked })}
        />
        <span>{t("consent.externalAsrProcessing")}</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.guardianApproved}
          onChange={(event) => onConsentChange({ ...consent, guardianApproved: event.target.checked })}
        />
        <span>{t("consent.guardianApproved")}</span>
      </label>
    </div>
  );
}
