import { AlertTriangle, Headphones, ShieldCheck, Sparkles, Send } from "lucide-react";
import type { PracticeMode, MicState } from "../types/practice";

export function ModeBanner({
  micState,
  mode,
  onCheckMic,
  onSendToTeacher,
}: {
  micState: MicState;
  mode: Exclude<PracticeMode, "home">;
  onCheckMic: () => void;
  onSendToTeacher: () => void;
}) {
  if (micState === "denied") {
    return (
      <div className="state-banner warning" role="status">
        <AlertTriangle size={18} />
        Microphone access is denied. You can still listen and practice, then ask a teacher to review in class.
        <button onClick={onCheckMic} type="button">Try again</button>
      </div>
    );
  }

  if (micState === "unavailable") {
    return (
      <div className="state-banner warning" role="status">
        <AlertTriangle size={18} />
        Microphone capture is unavailable on this device. Continue with listen mode or teacher review.
      </div>
    );
  }

  if (mode === "correction") {
    return (
      <div className="state-banner low-confidence" role="status">
        <Sparkles size={18} />
        Low-confidence guidance: three words need a gentle review before feedback is shown as final.
        <button onClick={onSendToTeacher} type="button">
          <Send size={15} />
          Send to teacher
        </button>
      </div>
    );
  }

  if (mode === "drill") {
    return (
      <div className="state-banner teacher" role="status">
        <ShieldCheck size={18} />
        Sent to teacher. For now, repeat the short phrase slowly three times.
      </div>
    );
  }

  return (
    <div className="state-banner calm" role="status">
      <Headphones size={18} />
      Learner view keeps model and gateway details hidden. Focus on the verse, pacing, and review.
    </div>
  );
}
