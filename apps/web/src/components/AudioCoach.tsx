import { Mic, Pause, Play, Volume2 } from "lucide-react";

interface AudioCoachProps {
  activeIndex: number;
  bars: number[];
  isRecording: boolean;
  onToggleRecording: () => void;
}

export function AudioCoach({ activeIndex, bars, isRecording, onToggleRecording }: AudioCoachProps) {
  return (
    <footer className="audio-coach" aria-label="Audio feedback">
      <div className="recording-state">
        <span className={isRecording ? "mic-orb recording" : "mic-orb"}>
          <Mic size={20} />
        </span>
        <div>
          <strong>{isRecording ? "Recording..." : "Ready"}</strong>
          <p>00:35 / 01:20</p>
        </div>
      </div>
      <button className="round-control" type="button" onClick={onToggleRecording}>
        {isRecording ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <div className="speed-control">
        <Volume2 size={16} />
        <span>1.0x</span>
      </div>
      <div className="waveform" aria-hidden="true">
        {bars.map((height, index) => (
          <span
            className={[
              index <= activeIndex ? "heard" : "",
              index === 24 || index === 61 ? "mistake" : "",
              index === 47 || index === 76 ? "needs-work" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={`${height}-${index}`}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
    </footer>
  );
}
