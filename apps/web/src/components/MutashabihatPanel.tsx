import { BookOpen } from "lucide-react";
import type { SimilarVerse } from "../data/quran";

interface MutashabihatPanelProps {
  verses: SimilarVerse[];
}

export function MutashabihatPanel({ verses }: MutashabihatPanelProps) {
  return (
    <section className="panel mutashabihat-panel" aria-label="Mutashabihat">
      <div className="panel-title">
        <h2>Mutashabihat</h2>
        <span>{verses.length}</span>
      </div>
      <div className="similar-list">
        {verses.map((verse) => (
          <article className="similar-row" key={verse.reference}>
            <BookOpen size={16} />
            <div>
              <p dir="rtl" lang="ar">{verse.arabic}</p>
              <span>{verse.reference} · {verse.reason}</span>
            </div>
          </article>
        ))}
      </div>
      <button className="text-action" type="button">View all 12</button>
    </section>
  );
}
