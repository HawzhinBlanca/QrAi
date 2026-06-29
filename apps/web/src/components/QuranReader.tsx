import type { QuranVerse } from "../data/quran";

interface QuranReaderProps {
  activeWordId: string;
  selectedWordId: string;
  verses: QuranVerse[];
  onSelectWord: (wordId: string) => void;
}

const statusLabels = {
  good: "Good",
  mistake: "Mistake",
  "needs-work": "Needs improvement",
  missed: "Missed",
};

export function QuranReader({ activeWordId, onSelectWord, selectedWordId, verses }: QuranReaderProps) {
  return (
    <section className="reader-panel" aria-label="Quran reader">
      <div className="reader-frame">
        {verses.map((verse) => (
          <div className="verse-line" key={verse.id}>
            <span className="verse-number">{verse.verseNumber}</span>
            <div className="arabic-line" dir="rtl" lang="ar">
              {verse.words.map((word) => (
                <button
                  aria-label={`${word.text} ${statusLabels[word.status]}`}
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

      <div className="legend" aria-label="Word status legend">
        <span><i className="dot good" /> Good</span>
        <span><i className="dot needs-work" /> Needs improvement</span>
        <span><i className="dot mistake" /> Mistake</span>
        <span><i className="dot missed" /> Missed</span>
      </div>
    </section>
  );
}
