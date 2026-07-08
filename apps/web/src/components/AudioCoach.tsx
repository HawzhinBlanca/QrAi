import { Loader2, Mic, Pause, Play, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface AudioCoachProps {
  bars: number[];
  activeIndex: number;
  isRecording: boolean;
  isAnalyzing: boolean;
  hasRecording: boolean;
  isPlayingRecording: boolean;
  isPlayingReference: boolean;
  onToggleRecording: () => void;
  onPlayRecording: () => void;
  onPlayReference: () => void;
}

export function AudioCoach({
  bars,
  activeIndex,
  isRecording,
  isAnalyzing,
  hasRecording,
  isPlayingRecording,
  isPlayingReference,
  onToggleRecording,
  onPlayRecording,
  onPlayReference,
}: AudioCoachProps) {
  const { t } = useTranslation();
  const status = isRecording
    ? t("audioCoach.statusRecording")
    : isAnalyzing
      ? t("audioCoach.statusAnalyzing")
      : hasRecording
        ? t("audioCoach.statusReady")
        : t("audioCoach.statusReadyToRecite");
  const hint = isRecording
    ? t("audioCoach.hintRecording")
    : isAnalyzing
      ? t("audioCoach.hintAnalyzing")
      : hasRecording
        ? t("audioCoach.hintReady")
        : t("audioCoach.hintReadyToRecite");

  const orbState = isRecording ? "recording" : hasRecording ? "done" : "";

  return (
    <footer className="audio-coach" aria-label={t("audioCoach.ariaLabel")}>
      <div className="coach-status">
        <span className={`mic-orb ${orbState}`}>
          {isAnalyzing ? <Loader2 className="spin" size={20} /> : <Mic size={20} />}
        </span>
        <div>
          <strong>{status}</strong>
          <p>{hint}</p>
        </div>
      </div>

      <div className={isRecording ? "waveform live" : "waveform"} aria-hidden="true">
        {bars.map((height, index) => (
          <span className={index <= activeIndex ? "heard" : ""} key={index} style={{ height: `${height}%` }} />
        ))}
      </div>

      <div className="coach-actions">
        <button
          className={isRecording ? "record-btn recording" : "record-btn"}
          type="button"
          onClick={onToggleRecording}
          disabled={isAnalyzing}
          aria-label={isRecording ? t("audioCoach.stopRecording") : t("audioCoach.recordYourRecitation")}
        >
          {isRecording ? <Square size={20} fill="currentColor" /> : <Mic size={22} />}
          <span>{isRecording ? t("audioCoach.stop") : hasRecording ? t("audioCoach.recordAgain") : t("audioCoach.record")}</span>
        </button>

        {hasRecording && !isRecording && (
          <button
            className={isPlayingRecording ? "coach-secondary active" : "coach-secondary"}
            type="button"
            onClick={onPlayRecording}
            disabled={isAnalyzing}
            aria-label={isPlayingRecording ? t("audioCoach.pauseMyRecitation") : t("audioCoach.playMyRecitation")}
          >
            {isPlayingRecording ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            <span>{t("audioCoach.myRecitation")}</span>
          </button>
        )}

        <button
          className={isPlayingReference ? "coach-secondary active" : "coach-secondary"}
          type="button"
          onClick={onPlayReference}
          disabled={isRecording || isAnalyzing}
          aria-label={isPlayingReference ? t("audioCoach.pauseReferenceRecitation") : t("audioCoach.playReferenceRecitation")}
        >
          {isPlayingReference ? <Pause size={18} fill="currentColor" /> : <Volume2 size={18} />}
          <span>{t("audioCoach.reference")}</span>
        </button>
      </div>
    </footer>
  );
}
