import { Clock3, Headphones, Mic, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConsentPanel } from "./ConsentPanel";
import { MicNotice } from "./MicNotice";
import { SurahPicker } from "./SurahPicker";
import type { MicState } from "../types/practice";
import type { RecitationConsent, SurahInfo } from "../lib/api";
import type { MemorizationPlan, LearnerProgress } from "../data/platform";
import { surahLabel } from "../lib/surah";

export interface LearnerHomeProps {
  micState: MicState;
  onCheckMic: () => void;
  onStartPractice: () => void;
  memorizationPlan: MemorizationPlan | null;
  progress: LearnerProgress | null;
  consent: RecitationConsent;
  onConsentChange: (consent: RecitationConsent) => void;
  surahList: SurahInfo[];
  selectedSurah: SurahInfo;
  onSelectSurah: (surah: SurahInfo) => void;
}

export function LearnerHome({
  micState,
  onCheckMic,
  onStartPractice,
  memorizationPlan,
  progress,
  consent,
  onConsentChange,
  surahList,
  selectedSurah,
  onSelectSurah,
}: LearnerHomeProps) {
  const { t } = useTranslation();
  const masteryPct = Math.round((progress?.mastery ?? 0) * 100);
  return (
    <section className="learner-home" aria-label={t("learnerHome.ariaLabel")}>
      <div className="mission-hero">
        <div className="mission-copy">
          <p className="quiet-label">{t("learnerHome.todaysMission")}</p>
          <h1>{t("learnerHome.missionHeading", { surah: surahLabel(selectedSurah) })}</h1>
          <p>{t("learnerHome.missionBody")}</p>
          <SurahPicker surahs={surahList} selected={selectedSurah} onSelect={onSelectSurah} />
          <ConsentPanel consent={consent} onConsentChange={onConsentChange} />
          <div className="mission-actions">
            <button className="primary-action start-practice-button" onClick={onStartPractice} type="button">
              <Mic size={18} />
              {t("learnerHome.startPractice")}
            </button>
            <button className="secondary-action" onClick={onCheckMic} type="button">
              {t("learnerHome.checkMicrophone")}
            </button>
          </div>
          <MicNotice micState={micState} />
        </div>
        <div className="mission-card" aria-label={t("learnerHome.masterySummaryAriaLabel")}>
          <div className="mastery-ring" style={{ "--score": `${masteryPct * 3.6}deg` } as React.CSSProperties}>
            <strong>{masteryPct}%</strong>
            <span>{t("learnerHome.mastery")}</span>
          </div>
          <dl>
            <div>
              <dt>{t("learnerHome.nextReview")}</dt>
              <dd>{memorizationPlan?.nextReviewAt ?? t("learnerHome.notScheduled")}</dd>
            </div>
            <div>
              <dt>{t("learnerHome.dueToday")}</dt>
              <dd>{memorizationPlan?.intervals?.[0]?.dueCount ?? 0}</dd>
            </div>
            <div>
              <dt>{t("learnerHome.streak")}</dt>
              <dd>{t("learnerHome.streakDays", { count: progress?.streak ?? 0 })}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="learner-summary-grid">
        <article className="summary-tile">
          <Headphones size={20} />
          <span>{t("learnerHome.practiceMode")}</span>
          <strong>{t("learnerHome.practiceModeValue")}</strong>
        </article>
        <article className="summary-tile">
          <Clock3 size={20} />
          <span>{t("learnerHome.estimatedTime")}</span>
          <strong>{t("learnerHome.estimatedTimeValue")}</strong>
        </article>
        <article className="summary-tile">
          <ShieldCheck size={20} />
          <span>{t("learnerHome.trustState")}</span>
          <strong>{t("learnerHome.trustStateValue")}</strong>
        </article>
      </div>
    </section>
  );
}
