import type { MicState } from "../types/practice";

export function MicNotice({ micState }: { micState: MicState }) {
  const copyByState: Record<MicState, string> = {
    idle: "Microphone is optional until guided recite.",
    checking: "Checking microphone permission...",
    ready: "Microphone is ready for guided recite.",
    denied: "Microphone denied. Practice still works in listen and teacher-review mode.",
    unavailable: "Microphone unavailable on this device.",
  };

  return <p className={`mic-notice ${micState}`}>{copyByState[micState]}</p>;
}
