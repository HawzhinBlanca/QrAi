import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { QuranVerse } from "../data/quran";

interface QuranReaderProps {
  activeWordId: string;
  selectedWordId: string;
  verses: QuranVerse[];
  onSelectWord: (wordId: string) => void;
  /** Local ayah (verseNumber) currently playing in the Listen step, or null. */
  playingVerseNumber?: number | null;
  /** True while the surah's verses are being (re)fetched — marks the reader aria-busy and dims it
   *  so a slow/switched surah reads as loading, not frozen (P2.9). */
  isLoading?: boolean;
}

const statusLabelKeys = {
  good: "quranReader.statusGood",
  mistake: "quranReader.statusMistake",
  "needs-work": "quranReader.statusNeedsWork",
  missed: "quranReader.statusMissed",
};

export function QuranReader({ activeWordId, onSelectWord, selectedWordId, verses, playingVerseNumber = null, isLoading = false }: QuranReaderProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement | null>(null);

  // Keep the verse the learner is hearing in view during the Listen step (audio-text sync).
  useEffect(() => {
    if (playingVerseNumber == null) return;
    const el = frameRef.current?.querySelector<HTMLElement>(`[data-verse="${playingVerseNumber}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [playingVerseNumber]);

  return (
    <section className="reader-panel" aria-label={t("quranReader.ariaLabel")} aria-busy={isLoading}>
      <div className={isLoading ? "reader-frame is-loading" : "reader-frame"} ref={frameRef}>
        {verses.map((verse) => (
          <div
            className={verse.verseNumber === playingVerseNumber ? "verse-line is-playing" : "verse-line"}
            key={verse.id}
            data-verse={verse.verseNumber}
            aria-current={verse.verseNumber === playingVerseNumber ? "true" : undefined}
          >
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
