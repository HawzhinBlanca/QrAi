import { AlertTriangle, ShieldAlert, Sparkles } from "lucide-react";
import type { TajweedFinding } from "../lib/api";

interface TajweedPanelProps {
  findings: TajweedFinding[];
}

const ICONS = {
  practice: Sparkles,
  warning: AlertTriangle,
  critical: ShieldAlert,
} as const;

export function TajweedPanel({ findings }: TajweedPanelProps) {
  return (
    <section className="panel tajweed-panel" aria-label="Tajweed feedback">
      <div className="panel-title">
        <h2>Tajweed</h2>
        <span>{findings.length}</span>
      </div>
      {findings.length === 0 ? (
        <p className="panel-empty">Recite to get tajweed feedback (makhraj, madd, ghunnah).</p>
      ) : (
        <div className="tajweed-list">
          {findings.map((finding) => {
            const Icon = ICONS[finding.severity] ?? Sparkles;
            return (
              <div className={`tajweed-card ${finding.severity}`} key={`${finding.wordId}-${finding.rule}`}>
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
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
