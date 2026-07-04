import { Clock3, Headphones, Mic, ShieldCheck } from "lucide-react";
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
  const masteryPct = Math.round((progress?.mastery ?? 0) * 100);
  return (
    <section className="learner-home" aria-label="Learner home">
      <div className="mission-hero">
        <div className="mission-copy">
          <p className="quiet-label">Today's mission</p>
          <h1>Strengthen {surahLabel(selectedSurah)} with a calm mastery loop.</h1>
          <p>
            Listen once, recite with guidance, try from memory, then repeat only the words that need attention.
          </p>
          <SurahPicker surahs={surahList} selected={selectedSurah} onSelect={onSelectSurah} />
          <ConsentPanel consent={consent} onConsentChange={onConsentChange} />
          <div className="mission-actions">
            <button className="primary-action start-practice-button" onClick={onStartPractice} type="button">
              <Mic size={18} />
              Start Practice
            </button>
            <button className="secondary-action" onClick={onCheckMic} type="button">
              Check microphone
            </button>
          </div>
          <MicNotice micState={micState} />
        </div>
        <div className="mission-card" aria-label="Mastery summary">
          <div className="mastery-ring" style={{ "--score": `${masteryPct * 3.6}deg` } as React.CSSProperties}>
            <strong>{masteryPct}%</strong>
            <span>Mastery</span>
          </div>
          <dl>
            <div>
              <dt>Next review</dt>
              <dd>{memorizationPlan?.nextReviewAt ?? "Not scheduled"}</dd>
            </div>
            <div>
              <dt>Due today</dt>
              <dd>{memorizationPlan?.intervals?.[0]?.dueCount ?? 0}</dd>
            </div>
            <div>
              <dt>Streak</dt>
              <dd>{progress?.streak ?? 0} days</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="learner-summary-grid">
        <article className="summary-tile">
          <Headphones size={20} />
          <span>Practice mode</span>
          <strong>Listen first, then recite</strong>
        </article>
        <article className="summary-tile">
          <Clock3 size={20} />
          <span>Estimated time</span>
          <strong>8 minutes</strong>
        </article>
        <article className="summary-tile">
          <ShieldCheck size={20} />
          <span>Trust state</span>
          <strong>Teacher review available</strong>
        </article>
      </div>
    </section>
  );
}
