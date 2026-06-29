import { Award, Flame, Trophy } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import type { ProgressBar } from "../data/quran";

interface ProgressPanelProps {
  accuracy: number;
  correctWords: number;
  mistakes: number;
  weeklyProgress: ProgressBar[];
}

export function ProgressPanel({ accuracy, correctWords, mistakes, weeklyProgress }: ProgressPanelProps) {
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
            <dd>18</dd>
          </div>
          <div>
            <dt>Time practiced</dt>
            <dd>2h 45m</dd>
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
        <ResponsiveContainer height={96} width="100%">
          <BarChart data={weeklyProgress}>
            <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#7d7769", fontSize: 11 }} />
            <Tooltip cursor={{ fill: "rgba(8, 128, 102, 0.08)" }} />
            <Bar dataKey="accuracy" fill="#088066" radius={[8, 8, 0, 0]} barSize={9} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="badge-row">
        <span><Flame size={15} /> 12 days</span>
        <span><Trophy size={15} /> Gold</span>
        <span><Award size={15} /> Level 4</span>
      </div>
    </section>
  );
}
