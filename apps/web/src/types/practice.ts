/** Practice flow types shared across extracted components. */

export type PracticeMode = "home" | "listen" | "guided-recite" | "memory-recite" | "correction" | "drill" | "complete";

export type MicState = "idle" | "checking" | "ready" | "denied" | "unavailable";

export type AppSection = "learner" | "teacher" | "scholar" | "model-ops" | "trust" | "admin" | "badges" | "teachers" | "settings";

// labelKey/helperKey (not literal text) so PracticeFlow.tsx can pass them through i18next's t() --
// this file is plain data (no React context to call useTranslation() from), so it can only ever
// carry translation KEYS, not translated strings themselves.
export const practiceSteps: Array<{ id: Exclude<PracticeMode, "home">; labelKey: string; helperKey: string }> = [
  { id: "listen", labelKey: "practiceSteps.listen.label", helperKey: "practiceSteps.listen.helper" },
  { id: "guided-recite", labelKey: "practiceSteps.guidedRecite.label", helperKey: "practiceSteps.guidedRecite.helper" },
  { id: "memory-recite", labelKey: "practiceSteps.memoryRecite.label", helperKey: "practiceSteps.memoryRecite.helper" },
  { id: "correction", labelKey: "practiceSteps.correction.label", helperKey: "practiceSteps.correction.helper" },
  { id: "drill", labelKey: "practiceSteps.drill.label", helperKey: "practiceSteps.drill.helper" },
  { id: "complete", labelKey: "practiceSteps.complete.label", helperKey: "practiceSteps.complete.helper" },
];

// Idle-state waveform placeholder: a uniform low baseline that reads as "no audio yet".
// A previous version generated pseudo-random heights (28 + (i*17) % 54), which looked like a
// real recorded waveform when nothing had been recorded — fabricated-looking data in the UI.
// During recording, PracticeFlow swaps this for the REAL live mic levels (liveBars).
export const waveformBars = Array.from({ length: 88 }, () => 12);
