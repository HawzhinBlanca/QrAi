import { useState } from "react";
import { Clock3, Headphones, Mic, Sparkles, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConsentPanel } from "./ConsentPanel";
import { MicNotice } from "./MicNotice";
import { SurahPicker } from "./SurahPicker";
import type { MicState } from "../types/practice";
import type { RecitationConsent, SurahInfo } from "../lib/api";
import type { MemorizationPlan, LearnerProgress } from "../data/platform";
import { practiceRange, surahLabel } from "../lib/surah";

const ONBOARDING_DISMISSED_KEY = "quran-ai-onboarding-dismissed";

function readOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

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
  /** A data-load error (e.g. verses/progress fetch failed) — surfaced here so a home-screen
   *  failure isn't silent; previously apiError only showed inside the practice flow. */
  apiError: string | null;
  platformOffline?: boolean;
  onRetry?: () => void;
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
  apiError,
  platformOffline,
  onRetry,
}: LearnerHomeProps) {
  const { t } = useTranslation();
  const isNewLearner = (progress?.totalSessions ?? 0) === 0;
  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);
  function dismissOnboarding() {
    setOnboardingDismissed(true);
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // Non-persistent (private mode / storage disabled) — the card just reappears next load.
    }
  }

  if (platformOffline) {
    return (
      <section className="learner-home" aria-label={t("learnerHome.ariaLabel")}>
        <div 
          className="offline-card" 
          style={{ 
            maxWidth: "600px", 
            margin: "60px auto", 
            padding: "40px 32px", 
            textAlign: "center", 
            background: "rgba(30, 41, 59, 0.4)",
            backdropFilter: "blur(12px)",
            borderRadius: "16px", 
            border: "1px solid rgba(255, 255, 255, 0.08)", 
            display: "flex", 
            flexDirection: "column", 
            alignItems: "center", 
            gap: "20px",
            boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.3)"
          }}
        >
          <div 
            style={{ 
              width: "64px", 
              height: "64px", 
              borderRadius: "50%", 
              background: "rgba(239, 68, 68, 0.1)", 
              display: "flex", 
              alignItems: "center", 
              justifyContent: "center", 
              border: "1px solid rgba(239, 68, 68, 0.2)",
              color: "#ef4444"
            }}
          >
            <ShieldCheck size={32} />
          </div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--text)" }}>
            {t("app.errors.practiceUnavailableTitle")}
          </h2>
          <p style={{ color: "var(--text-quiet)", lineHeight: 1.6, fontSize: "0.95rem" }}>
            {t("app.errors.practiceUnavailableBody")}
          </p>
          <button 
            className="primary-action start-practice-button" 
            onClick={onRetry} 
            type="button" 
            style={{ marginTop: "12px", padding: "10px 24px", minWidth: "160px" }}
          >
            {t("app.errors.retryConnection")}
          </button>
        </div>
      </section>
    );
  }

  const masteryPct = Math.round((progress?.mastery ?? 0) * 100);
  // Labeled estimate derived from the REAL session the learner is about to start (the same
  // practiceRange cap the practice flow uses): ~1 minute per ayah in the loop + 2 minutes for
  // listen/review overhead. A previous version showed a frozen "8 minutes" for every surah.
  const sessionAyahs = practiceRange(selectedSurah).ayahEnd;
  const estimatedMinutes = sessionAyahs + 2;
  const showOnboarding = isNewLearner && !onboardingDismissed;
  return (
    <section className="learner-home" aria-label={t("learnerHome.ariaLabel")}>
      {showOnboarding && (
        <aside className="onboarding-card" aria-label={t("learnerHome.onboardingAriaLabel")}>
          <button
            className="onboarding-dismiss"
            type="button"
            onClick={dismissOnboarding}
            aria-label={t("learnerHome.onboardingDismiss")}
          >
            <X size={16} />
          </button>
          <p className="quiet-label">{t("learnerHome.onboardingEyebrow")}</p>
          <h2>{t("learnerHome.onboardingTitle")}</h2>
          <ol className="onboarding-steps">
            <li>{t("learnerHome.onboardingStepListen")}</li>
            <li>{t("learnerHome.onboardingStepRecite")}</li>
            <li>{t("learnerHome.onboardingStepMemory")}</li>
            <li>{t("learnerHome.onboardingStepCorrect")}</li>
          </ol>
        </aside>
      )}
      <div className="mission-hero">
        <div className="mission-copy">
          <p className="quiet-label">{t("learnerHome.todaysMission")}</p>
          <h1>{t("learnerHome.missionHeading", { surah: surahLabel(selectedSurah) })}</h1>
          <p>{t("learnerHome.missionBody")}</p>
          <SurahPicker surahs={surahList} selected={selectedSurah} onSelect={onSelectSurah} />
          {apiError && (
            <div className="state-banner warning" role="alert">
              {apiError}
            </div>
          )}
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
          {isNewLearner ? (
            // No sessions yet: invite the first recitation rather than showing 0%/0/0, which reads
            // as failure before the learner has begun.
            <div className="mastery-empty">
              <Sparkles size={26} />
              <strong>{t("learnerHome.masteryEmptyTitle")}</strong>
              <p>{t("learnerHome.masteryEmptyBody")}</p>
            </div>
          ) : (
            <>
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
            </>
          )}
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
          <strong>{t("learnerHome.estimatedTimeValue", { minutes: estimatedMinutes })}</strong>
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
