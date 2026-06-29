import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { RecitationEvent } from "../data/quran";

interface IssuePanelProps {
  events: RecitationEvent[];
  selectedWordId: string;
  onSelectWord: (wordId: string) => void;
}

const titleByKind = {
  mistake: "Mistakes",
  missed: "Missed words",
  "needs-work": "Needs improvement",
};

export function IssuePanel({ events, onSelectWord, selectedWordId }: IssuePanelProps) {
  return (
    <section className="panel issue-panel" aria-label="Detected recitation issues">
      <div className="panel-title">
        <h2>Mistakes</h2>
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
              <span>{titleByKind[event.kind]}</span>
              <time>{event.timestamp}</time>
            </div>
            <p className="arabic-mini" dir="rtl" lang="ar">{event.word}</p>
            <dl>
              <div>
                <dt>Heard</dt>
                <dd>{event.heard}</dd>
              </div>
              <div>
                <dt>Coach</dt>
                <dd>{event.note}</dd>
              </div>
            </dl>
          </button>
        ))}
      </div>
    </section>
  );
}
