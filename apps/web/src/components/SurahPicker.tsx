import type { SurahInfo } from "../lib/api";

/**
 * Accessible surah selector. A native <select> is used deliberately: it gives full
 * keyboard + screen-reader support for free and renders as the platform-native wheel
 * picker on mobile — the right feel for choosing among 114 items. Before the list loads
 * it shows the current selection as the sole (disabled) option so the control never
 * appears empty.
 */
export function SurahPicker({
  surahs,
  selected,
  onSelect,
}: {
  surahs: SurahInfo[];
  selected: SurahInfo;
  onSelect: (surah: SurahInfo) => void;
}) {
  const options = surahs.length > 0 ? surahs : [selected];
  return (
    <div className="surah-picker">
      <label className="quiet-label" htmlFor="surah-picker-select">
        Practice surah
      </label>
      <select
        id="surah-picker-select"
        className="surah-picker-select"
        value={selected.surahNumber}
        disabled={surahs.length === 0}
        onChange={(event) => {
          const surahNumber = Number(event.target.value);
          const next = surahs.find((surah) => surah.surahNumber === surahNumber);
          if (next) onSelect(next);
        }}
      >
        {options.map((surah) => (
          <option key={surah.surahNumber} value={surah.surahNumber}>
            {surah.surahNumber}. {surah.name}
            {surah.translation ? ` — ${surah.translation}` : ""} ({surah.ayahCount} ayahs)
          </option>
        ))}
      </select>
    </div>
  );
}
