import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RecitationEvent } from "../data/quran";

interface IssuePanelProps {
  events: RecitationEvent[];
  selectedWordId: string;
  onSelectWord: (wordId: string) => void;
}

const titleKeyByKind = {
  mistake: "issuePanel.kindMistake",
  missed: "issuePanel.kindMissed",
  "needs-work": "issuePanel.kindNeedsWork",
};

export function IssuePanel({ events, onSelectWord, selectedWordId }: IssuePanelProps) {
  const { t } = useTranslation();
  return (
    <section className="panel issue-panel" aria-label={t("issuePanel.ariaLabel")}>
      <div className="panel-title">
        <h2>{t("issuePanel.title")}</h2>
        <span>{events.length}</span>
      </div>

      <div className="issue-list">
        {events.map((event) => (
          <button
            className={selectedWordId === event.wordId ? "issue-card selected" : "issue-card"}
            key={event.id}
            onClick={() => onSelectWord(event.wordId)}
            type="button"
          >
            <div className={`issue-kind ${event.kind}`}>
              {event.kind === "missed" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span>{t(titleKeyByKind[event.kind])}</span>
              <time>{event.timestamp}</time>
            </div>
            {/* event.word is canonical Quran text -- never translated. event.heard/event.note are
                constructed dynamically from live ASR/alignment results in data/quran.ts's
                buildRecitationEvents -- not yet i18n-extracted (see PR description). */}
            <p className="arabic-mini" dir="rtl" lang="ar">{event.word}</p>
            <dl>
              <div>
                <dt>{t("issuePanel.heard")}</dt>
                <dd>{event.heard}</dd>
              </div>
              <div>
                <dt>{t("issuePanel.coach")}</dt>
                <dd>{event.note}</dd>
              </div>
            </dl>
          </button>
        ))}
      </div>
    </section>
  );
}
