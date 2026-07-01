import { Loader2, Mic, Pause, Play, Square, Volume2 } from "lucide-react";

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
  const status = isRecording
    ? "Recording"
    : isAnalyzing
      ? "Analyzing your recitation…"
      : hasRecording
        ? "Your recitation is ready"
        : "Ready to recite";
  const hint = isRecording
    ? "Recite clearly — tap stop when you're done."
    : isAnalyzing
      ? "Listening with the Quran model."
      : hasRecording
        ? "Play it back, or record again."
        : "Tap the mic to record — or hear the reference first.";

  const orbState = isRecording ? "recording" : hasRecording ? "done" : "";

  return (
    <footer className="audio-coach" aria-label="Recording">
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
          aria-label={isRecording ? "Stop recording" : "Record your recitation"}
        >
          {isRecording ? <Square size={20} fill="currentColor" /> : <Mic size={22} />}
          <span>{isRecording ? "Stop" : hasRecording ? "Record again" : "Record"}</span>
        </button>

        {hasRecording && !isRecording && (
          <button
            className={isPlayingRecording ? "coach-secondary active" : "coach-secondary"}
            type="button"
            onClick={onPlayRecording}
            disabled={isAnalyzing}
            aria-label={isPlayingRecording ? "Pause my recitation" : "Play my recitation"}
          >
            {isPlayingRecording ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            <span>My recitation</span>
          </button>
        )}

        <button
          className={isPlayingReference ? "coach-secondary active" : "coach-secondary"}
          type="button"
          onClick={onPlayReference}
          disabled={isRecording || isAnalyzing}
          aria-label={isPlayingReference ? "Pause reference recitation" : "Play reference recitation"}
        >
          {isPlayingReference ? <Pause size={18} fill="currentColor" /> : <Volume2 size={18} />}
          <span>Reference</span>
        </button>
      </div>
    </footer>
  );
}
