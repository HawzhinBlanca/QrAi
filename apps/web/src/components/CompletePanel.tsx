import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemorizationPlan } from "../data/platform";

/** Honest completion state: only "saved" means a real SM-2 review was persisted. */
export type SaveState = "idle" | "saved" | "nothing-recited" | "failed";

export function CompletePanel({
  onReset,
  memorizationPlan,
  saveState,
}: {
  onReset: () => void;
  memorizationPlan: MemorizationPlan | null;
  saveState: SaveState;
}) {
  const { t } = useTranslation();
  // The body claims "Progress saved" ONLY when a review actually persisted. Reaching this panel
  // via the stepper chip without reciting (nothing-recited) or after a failed write (failed) must
  // say so instead — a previous version asserted "Progress saved." unconditionally.
  const bodyKey =
    saveState === "saved"
      ? "completePanel.bodySaved"
      : saveState === "failed"
        ? "completePanel.bodySaveFailed"
        : "completePanel.bodyNothingRecited";
  const nextReview = memorizationPlan?.nextReviewAt ?? t("completePanel.nextReviewDefault");
  return (
    <section className="panel complete-panel" aria-label={t("completePanel.ariaLabel")}>
      <div className="complete-mark">
        <CheckCircle2 size={34} />
      </div>
      <h2>{t("completePanel.title")}</h2>
      <p>{saveState === "saved" ? t(bodyKey, { nextReview }) : t(bodyKey)}</p>
      <button className="secondary-action" onClick={onReset} type="button">{t("completePanel.returnHome")}</button>
    </section>
  );
}
