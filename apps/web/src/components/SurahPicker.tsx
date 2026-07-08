import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const options = surahs.length > 0 ? surahs : [selected];
  return (
    <div className="surah-picker">
      <label className="quiet-label" htmlFor="surah-picker-select">
        {t("surahPicker.label")}
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
            {/* surah.name/translation are real Quran reference metadata (canonical, never
                translated by this app) -- only the surrounding structural text is a translation
                key. */}
            {surah.translation
              ? t("surahPicker.optionWithTranslation", {
                  number: surah.surahNumber,
                  name: surah.name,
                  translation: surah.translation,
                  count: surah.ayahCount,
                })
              : t("surahPicker.optionWithoutTranslation", {
                  number: surah.surahNumber,
                  name: surah.name,
                  count: surah.ayahCount,
                })}
          </option>
        ))}
      </select>
    </div>
  );
}
