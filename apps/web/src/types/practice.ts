/** Practice flow types shared across extracted components. */

export type PracticeMode = "home" | "listen" | "guided-recite" | "memory-recite" | "correction" | "drill" | "complete";

export type MicState = "idle" | "checking" | "ready" | "denied" | "unavailable";

export type AppSection = "learner" | "teacher" | "scholar" | "model-ops" | "trust" | "admin" | "badges" | "teachers" | "settings";

export const practiceSteps: Array<{ id: Exclude<PracticeMode, "home">; label: string; helper: string }> = [
  { id: "listen", label: "Listen", helper: "Hear the teacher-paced model once." },
  { id: "guided-recite", label: "Guided recite", helper: "Recite with the mushaf visible." },
  { id: "memory-recite", label: "Memory recite", helper: "Try without looking first." },
  { id: "correction", label: "Correction", helper: "Review only the words that need care." },
  { id: "drill", label: "Drill", helper: "Repeat the short phrase three times." },
  { id: "complete", label: "Complete", helper: "Save progress and next review." },
];

export const waveformBars = Array.from({ length: 88 }, (_, index) => 28 + ((index * 17) % 54));
