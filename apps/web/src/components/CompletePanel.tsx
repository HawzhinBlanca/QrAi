import { CheckCircle2 } from "lucide-react";
import type { MemorizationPlan } from "../data/platform";

export function CompletePanel({ onReset, memorizationPlan }: { onReset: () => void; memorizationPlan: MemorizationPlan | null }) {
  return (
    <section className="panel complete-panel" aria-label="Complete state">
      <div className="complete-mark">
        <CheckCircle2 size={34} />
      </div>
      <h2>Practice complete</h2>
      <p>Progress saved. Your next review stays scheduled for {memorizationPlan?.nextReviewAt ?? "your next session"}.</p>
      <button className="secondary-action" onClick={onReset} type="button">Return home</button>
    </section>
  );
}
