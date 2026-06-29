import { Bookmark, Pause, Play, RotateCcw, Settings } from "lucide-react";

interface PracticeHeaderProps {
  isRecording: boolean;
  onToggleRecording: () => void;
  onReset: () => void;
}

export function PracticeHeader({ isRecording, onReset, onToggleRecording }: PracticeHeaderProps) {
  return (
    <div className="practice-header">
      <div>
        <h1>Surah Al-Fatihah</h1>
        <p>Juz 1 · Page 1 · Adaptive tajweed mode</p>
      </div>
      <div className="practice-actions">
        <button className="icon-button" aria-label="Bookmark verse" type="button">
          <Bookmark size={20} />
        </button>
        <button className="primary-action" type="button" onClick={onToggleRecording}>
          {isRecording ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          {isRecording ? "Pause coach" : "Start recitation"}
        </button>
        <button className="icon-button" aria-label="Reset practice" type="button" onClick={onReset}>
          <RotateCcw size={18} />
        </button>
        <button className="icon-button" aria-label="Practice settings" type="button">
          <Settings size={18} />
        </button>
      </div>
    </div>
  );
}
