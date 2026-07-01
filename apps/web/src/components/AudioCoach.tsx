import { Mic, Pause, Play, Square, Volume2 } from "lucide-react";

interface AudioCoachProps {
  activeIndex: number;
  bars: number[];
  isRecording: boolean;
  isPlaying: boolean;
  onToggleRecording: () => void;
  onTogglePlay: () => void;
}

export function AudioCoach({
  activeIndex,
  bars,
  isRecording,
  isPlaying,
  onToggleRecording,
  onTogglePlay,
}: AudioCoachProps) {
  const status = isRecording ? "Recording…" : isPlaying ? "Playing recitation…" : "Ready";
  const hint = isRecording
    ? "Reciting — tap stop when done"
    : isPlaying
      ? "Mishary Al-Afasy · Al-Fatihah"
      : "Tap play to listen, mic to recite";

  return (
    <footer className="audio-coach" aria-label="Audio feedback">
      <div className="recording-state">
        <span className={isRecording ? "mic-orb recording" : "mic-orb"}>
          <Mic size={20} />
        </span>
        <div>
          <strong>{status}</strong>
          <p>{hint}</p>
        </div>
      </div>

      <button
        className="round-control"
        type="button"
        onClick={onTogglePlay}
        aria-label={isPlaying ? "Pause recitation" : "Play reference recitation"}
        title="Play the reference recitation"
      >
        {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>

      <button
        className={isRecording ? "round-control recording" : "round-control"}
        type="button"
        onClick={onToggleRecording}
        aria-label={isRecording ? "Stop recording" : "Record your recitation"}
        title="Record your recitation"
      >
        {isRecording ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}
      </button>

      <div className="speed-control">
        <Volume2 size={16} />
        <span>1.0x</span>
      </div>
      <div className={isRecording ? "waveform live" : "waveform"} aria-hidden="true">
        {bars.map((height, index) => (
          <span
            className={index <= activeIndex ? "heard" : ""}
            key={index}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
    </footer>
  );
}
