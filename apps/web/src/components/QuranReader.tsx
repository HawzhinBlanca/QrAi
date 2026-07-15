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
  /** Canonical id (`surah:ayah:index`) of the word currently being recited in the reference audio,
   *  for word-level follow-along. null when no timing data exists (verse-level highlight only). */
  recitingWordId?: string | null;
  /** Reciter/source attribution shown when the matched reference audio is in use (licensing). */
  recitationAttribution?: string | null;
  /** Local ayah number → verbatim translation text (empty map when none). */
  translationByAyah?: Map<number, string>;
  /** Translator/publisher attribution shown when translations are visible (licensing). */
  translationAttribution?: string | null;
  /** Whether the translation lines are shown. */
  showTranslation?: boolean;
  /** Toggle translation visibility. When omitted, the toggle control is hidden. */
  onToggleTranslation?: () => void;
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

export function QuranReader({ activeWordId, onSelectWord, selectedWordId, verses, playingVerseNumber = null, recitingWordId = null, recitationAttribution = null, translationByAyah, translationAttribution = null, showTranslation = false, onToggleTranslation, isLoading = false }: QuranReaderProps) {
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
      {onToggleTranslation && (translationByAyah?.size ?? 0) > 0 && (
        <div className="reader-controls">
          <button
            type="button"
            className={showTranslation ? "translation-toggle is-on" : "translation-toggle"}
            aria-pressed={showTranslation}
            onClick={onToggleTranslation}
          >
            {t("quranReader.translationToggle")}
          </button>
        </div>
      )}
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
                    recitingWordId === word.id ? "is-reciting" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-reciting={recitingWordId === word.id ? "true" : undefined}
                  key={word.id}
                  onClick={() => onSelectWord(word.id)}
                  type="button"
                >
                  {word.text}
                </button>
              ))}
            </div>
            {/* Sorani translation — verbatim licensed text (QuranEnc: no modification). Shown only
                when enabled AND present for this ayah; a missing ayah renders nothing (honest). */}
            {showTranslation && translationByAyah?.get(verse.verseNumber) && (
              <p className="verse-translation" dir="rtl" lang="ckb">
                {translationByAyah.get(verse.verseNumber)}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="legend" aria-label={t("quranReader.legendAriaLabel")}>
        <span><i className="dot good" /> {t("quranReader.statusGood")}</span>
        <span><i className="dot needs-work" /> {t("quranReader.statusNeedsWork")}</span>
        <span><i className="dot mistake" /> {t("quranReader.statusMistake")}</span>
        <span><i className="dot missed" /> {t("quranReader.statusMissed")}</span>
      </div>

      {recitationAttribution && (
        <p className="reader-attribution">{recitationAttribution}</p>
      )}
      {showTranslation && translationAttribution && (translationByAyah?.size ?? 0) > 0 && (
        <p className="reader-attribution">{t("quranReader.translationSource", { source: translationAttribution })}</p>
      )}
    </section>
  );
}
