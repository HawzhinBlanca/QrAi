import { Award, Flame, Trophy } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
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
  const level = Math.floor(mastery * 5) + 1;
  const badge = mastery >= 0.8 ? "Gold" : mastery >= 0.5 ? "Silver" : "Bronze";

  return (
    <section className="panel progress-panel" aria-label="Progress">
      <div className="panel-title">
        <h2>Progress</h2>
        <button type="button">This week</button>
      </div>
      <div className="progress-grid">
        <div className="accuracy-ring" style={{ "--score": `${accuracy * 3.6}deg` } as React.CSSProperties}>
          <strong>{accuracy}%</strong>
          <span>Accuracy</span>
        </div>
        <dl className="metric-stack">
          <div>
            <dt>Recitations</dt>
            <dd>{recitations}</dd>
          </div>
          <div>
            <dt>Mastery</dt>
            <dd>{Math.round(mastery * 100)}%</dd>
          </div>
          <div>
            <dt>Correct words</dt>
            <dd>{correctWords}</dd>
          </div>
          <div>
            <dt>Mistakes</dt>
            <dd>{mistakes}</dd>
          </div>
        </dl>
      </div>
      <div className="chart-wrap">
        {/* recharts renders a focusable role="application" SVG with no accessible name;
            the sr-only list below is the real text equivalent for keyboard/screen-reader users. */}
        <p className="sr-only" id="weekly-progress-chart-label">
          Weekly accuracy by day
        </p>
        <ul className="sr-only" aria-labelledby="weekly-progress-chart-label">
          {weeklyProgress.map((entry) => (
            <li key={entry.day}>
              {entry.day}: {entry.accuracy}% accuracy
            </li>
          ))}
        </ul>
        <ResponsiveContainer height={96} width="100%" aria-hidden="true">
          <BarChart data={weeklyProgress} tabIndex={-1}>
            <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#7d7769", fontSize: 11 }} />
            <Tooltip cursor={{ fill: "rgba(8, 128, 102, 0.08)" }} />
            <Bar dataKey="accuracy" fill="#088066" radius={[8, 8, 0, 0]} barSize={9} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="badge-row">
        <span>
          <Flame size={15} /> {streak} days
        </span>
        <span>
          <Trophy size={15} /> {badge}
        </span>
        <span>
          <Award size={15} /> Level {level}
        </span>
      </div>
    </section>
  );
}
