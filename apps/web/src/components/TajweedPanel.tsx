import { AlertTriangle, ShieldAlert, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TajweedFinding } from "../lib/api";
import { learnerVisibleTajweedFindings, tajweedReviewBadge } from "../lib/tajweedReview";

interface TajweedPanelProps {
  findings: TajweedFinding[];
}

const ICONS = {
  practice: Sparkles,
  warning: AlertTriangle,
  critical: ShieldAlert,
} as const;

export function TajweedPanel({ findings }: TajweedPanelProps) {
  const { t } = useTranslation();
  const learnerFindings = learnerVisibleTajweedFindings(findings);
  const hasWithheldFindings = findings.length > learnerFindings.length;

  return (
    <section className="panel tajweed-panel" aria-label={t("tajweedPanel.ariaLabel")}>
      <div className="panel-title">
        <h2>{t("tajweedPanel.title")}</h2>
        <span>{learnerFindings.length}</span>
      </div>
      {learnerFindings.length === 0 ? (
        <p className="panel-empty">
          {hasWithheldFindings ? t("tajweedPanel.awaitingReview") : t("tajweedPanel.empty")}
        </p>
      ) : (
        <div className="tajweed-list">
          {learnerFindings.map((finding) => {
            const Icon = ICONS[finding.severity] ?? Sparkles;
            const review = tajweedReviewBadge(finding);
            return (
              <div className={`tajweed-card ${finding.severity}`} key={`${finding.wordId}-${finding.rule}`}>
                {/* finding.rule/arabicName/explanation are real tajweed content from the
                    backend/model -- not translated here; that requires scholar review
                    (docs/SCHOLAR_REVIEW.md), same as canonical Quran text. */}
                <div className="tajweed-head">
                  <Icon size={16} />
                  <strong>{finding.rule}</strong>
                  {finding.arabicName && (
                    <span className="arabic-mini" dir="rtl" lang="ar">
                      {finding.arabicName}
                    </span>
                  )}
                  <span className="tajweed-conf">{Math.round(finding.confidence * 100)}%</span>
                </div>
                <p>{finding.explanation}</p>
                <span
                  className={`tajweed-review ${review.verified ? "verified" : "provisional"}`}
                  title={review.verified ? t("tajweedPanel.verifiedTitle") : t("tajweedPanel.aiSuggestionTitle")}
                >
                  {t(review.labelKey)}
                </span>
                <div className="tajweed-sources">
                  <strong>{t("tajweedPanel.sources")}</strong>
                  <ul>
                    {finding.sources.map((source) => (
                      <li key={`${finding.wordId}-${source.id}`}>
                        {source.url ? (
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                          </a>
                        ) : (
                          <span>{source.title}</span>
                        )}
                        <span>{source.citation}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
