import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemorizationPlan } from "../data/platform";

export function CompletePanel({ onReset, memorizationPlan }: { onReset: () => void; memorizationPlan: MemorizationPlan | null }) {
  const { t } = useTranslation();
  return (
    <section className="panel complete-panel" aria-label={t("completePanel.ariaLabel")}>
      <div className="complete-mark">
        <CheckCircle2 size={34} />
      </div>
      <h2>{t("completePanel.title")}</h2>
      <p>{t("completePanel.body", { nextReview: memorizationPlan?.nextReviewAt ?? t("completePanel.nextReviewDefault") })}</p>
      <button className="secondary-action" onClick={onReset} type="button">{t("completePanel.returnHome")}</button>
    </section>
  );
}
