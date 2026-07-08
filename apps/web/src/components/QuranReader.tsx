import { useTranslation } from "react-i18next";
import type { QuranVerse } from "../data/quran";

interface QuranReaderProps {
  activeWordId: string;
  selectedWordId: string;
  verses: QuranVerse[];
  onSelectWord: (wordId: string) => void;
}

const statusLabelKeys = {
  good: "quranReader.statusGood",
  mistake: "quranReader.statusMistake",
  "needs-work": "quranReader.statusNeedsWork",
  missed: "quranReader.statusMissed",
};

export function QuranReader({ activeWordId, onSelectWord, selectedWordId, verses }: QuranReaderProps) {
  const { t } = useTranslation();
  return (
    <section className="reader-panel" aria-label={t("quranReader.ariaLabel")}>
      <div className="reader-frame">
        {verses.map((verse) => (
          <div className="verse-line" key={verse.id}>
            <span className="verse-number">{verse.verseNumber}</span>
            {/* word.text is canonical Quran text (Uthmani script) -- never translated, per
                AGENTS.md's canonical-text invariant. Only the status label is translated. */}
            <div className="arabic-line" dir="rtl" lang="ar">
              {verse.words.map((word) => (
                <button
                  aria-label={t("quranReader.wordAriaLabel", { text: word.text, status: t(statusLabelKeys[word.status]) })}
                  className={[
                    "word-token",
                    `status-${word.status}`,
                    activeWordId === word.id ? "is-active" : "",
                    selectedWordId === word.id ? "is-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={word.id}
                  onClick={() => onSelectWord(word.id)}
                  type="button"
                >
                  {word.text}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="legend" aria-label={t("quranReader.legendAriaLabel")}>
        <span><i className="dot good" /> {t("quranReader.statusGood")}</span>
        <span><i className="dot needs-work" /> {t("quranReader.statusNeedsWork")}</span>
        <span><i className="dot mistake" /> {t("quranReader.statusMistake")}</span>
        <span><i className="dot missed" /> {t("quranReader.statusMissed")}</span>
      </div>
    </section>
  );
}
