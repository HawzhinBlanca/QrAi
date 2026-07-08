import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SimilarVerse } from "../data/quran";

interface MutashabihatPanelProps {
  verses: SimilarVerse[];
}

export function MutashabihatPanel({ verses }: MutashabihatPanelProps) {
  const { t } = useTranslation();
  return (
    <section className="panel mutashabihat-panel" aria-label={t("mutashabihatPanel.ariaLabel")}>
      <div className="panel-title">
        <h2>{t("mutashabihatPanel.title")}</h2>
        <span>{verses.length}</span>
      </div>
      <div className="similar-list">
        {/* verse.arabic/reference/reason are real Quran reference content -- not translated here. */}
        {verses.map((verse) => (
          <article className="similar-row" key={verse.reference}>
            <BookOpen size={16} />
            <div>
              <p dir="rtl" lang="ar">{verse.arabic}</p>
              <span>{verse.reference} · {verse.reason}</span>
            </div>
          </article>
        ))}
        {verses.length === 0 && <p className="panel-empty">{t("mutashabihatPanel.empty")}</p>}
      </div>
    </section>
  );
}
