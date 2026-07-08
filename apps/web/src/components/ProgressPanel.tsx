import { Award, Flame, Trophy } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { useTranslation } from "react-i18next";
import type { ProgressBar } from "../data/quran";

interface ProgressPanelProps {
  accuracy: number;
  correctWords: number;
  mistakes: number;
  recitations: number;
  streak: number;
  mastery: number;
  weeklyProgress: ProgressBar[];
}

export function ProgressPanel({
  accuracy,
  correctWords,
  mistakes,
  recitations,
  streak,
  mastery,
  weeklyProgress,
}: ProgressPanelProps) {
  const { t, i18n } = useTranslation();
  const level = Math.floor(mastery * 5) + 1;
  const badgeKey = mastery >= 0.8 ? "progress.badgeGold" : mastery >= 0.5 ? "progress.badgeSilver" : "progress.badgeBronze";
  // Localized short weekday labels from the API's real UTC dates. Parsed as UTC midnight so the
  // label matches the day the backend aggregated, regardless of the viewer's timezone.
  const dayLabel = new Intl.DateTimeFormat(i18n.language, { weekday: "short", timeZone: "UTC" });
  const chartData = weeklyProgress.map((entry) => ({
    ...entry,
    label: dayLabel.format(new Date(`${entry.date}T00:00:00Z`)),
  }));

  return (
    <section className="panel progress-panel" aria-label={t("progress.ariaLabel")}>
      <div className="panel-title">
        <h2>{t("progress.title")}</h2>
        <button type="button">{t("progress.thisWeek")}</button>
      </div>
      <div className="progress-grid">
        <div className="accuracy-ring" style={{ "--score": `${accuracy * 3.6}deg` } as React.CSSProperties}>
          <strong>{accuracy}%</strong>
          <span>{t("progress.accuracy")}</span>
        </div>
        <dl className="metric-stack">
          <div>
            <dt>{t("progress.recitations")}</dt>
            <dd>{recitations}</dd>
          </div>
          <div>
            <dt>{t("progress.mastery")}</dt>
            <dd>{Math.round(mastery * 100)}%</dd>
          </div>
          <div>
            <dt>{t("progress.correctWords")}</dt>
            <dd>{correctWords}</dd>
          </div>
          <div>
            <dt>{t("progress.mistakes")}</dt>
            <dd>{mistakes}</dd>
          </div>
        </dl>
      </div>
      <div className="chart-wrap">
        {chartData.length === 0 ? (
          // Honest empty state: no measured practice days yet. Never render invented bars.
          <p className="chart-empty">{t("progress.chartEmpty")}</p>
        ) : (
          <>
            {/* recharts renders a focusable role="application" SVG with no accessible name;
                the sr-only list below is the real text equivalent for keyboard/screen-reader users. */}
            <p className="sr-only" id="weekly-progress-chart-label">
              {t("progress.chartLabel")}
            </p>
            <ul className="sr-only" aria-labelledby="weekly-progress-chart-label">
              {chartData.map((entry) => (
                <li key={entry.date}>
                  {entry.accuracy === null
                    ? t("progress.chartEntryPending", { day: entry.label, count: entry.sessions })
                    : t("progress.chartEntry", { day: entry.label, accuracy: entry.accuracy })}
                </li>
              ))}
            </ul>
            <ResponsiveContainer height={96} width="100%" aria-hidden="true">
              <BarChart data={chartData} tabIndex={-1}>
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#7d7769", fontSize: 11 }} />
                <Tooltip cursor={{ fill: "rgba(8, 128, 102, 0.08)" }} />
                <Bar dataKey="accuracy" fill="#088066" radius={[8, 8, 0, 0]} barSize={9} />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
      <div className="badge-row">
        <span>
          <Flame size={15} /> {t("progress.streakDays", { count: streak })}
        </span>
        <span>
          <Trophy size={15} /> {t(badgeKey)}
        </span>
        <span>
          <Award size={15} /> {t("progress.level", { level })}
        </span>
      </div>
    </section>
  );
}
