import { AlertTriangle, Headphones, ShieldCheck, Sparkles, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PracticeMode, MicState } from "../types/practice";

export type TeacherSendState = "idle" | "sent" | "failed" | "nothing-to-send";

export function ModeBanner({
  micState,
  mode,
  mistakes,
  teacherSendState,
  onCheckMic,
  onSendToTeacher,
}: {
  micState: MicState;
  mode: Exclude<PracticeMode, "home">;
  /** Real count of words flagged in this session's alignment — never a hardcoded number. */
  mistakes: number;
  /** Truthful result of the send-to-teacher request — the drill banner claims "sent" only when
   *  the backend confirmed it (a previous version claimed it unconditionally). */
  teacherSendState: TeacherSendState;
  onCheckMic: () => void;
  onSendToTeacher: () => void;
}) {
  const { t } = useTranslation();
  if (micState === "denied") {
    return (
      <div className="state-banner warning" role="status">
        <AlertTriangle size={18} />
        {t("modeBanner.deniedText")}
        <button onClick={onCheckMic} type="button">{t("modeBanner.tryAgain")}</button>
      </div>
    );
  }

  if (micState === "unavailable") {
    return (
      <div className="state-banner warning" role="status">
        <AlertTriangle size={18} />
        {t("modeBanner.unavailableText")}
      </div>
    );
  }

  if (mode === "correction") {
    return (
      <div className="state-banner low-confidence" role="status">
        <Sparkles size={18} />
        {/* The count is the session's real flagged-word count (a previous version hardcoded
            "three words" regardless of what actually happened). */}
        {mistakes > 0
          ? t("modeBanner.correctionText", { count: mistakes })
          : t("modeBanner.correctionTextNoMistakes")}
        <button onClick={onSendToTeacher} type="button">
          <Send size={15} />
          {t("modeBanner.sendToTeacher")}
        </button>
      </div>
    );
  }

  if (mode === "drill") {
    // Truthful per-outcome copy: "sent" only when the backend confirmed the review request.
    const drillKey =
      teacherSendState === "sent"
        ? "modeBanner.drillTextSent"
        : teacherSendState === "failed"
          ? "modeBanner.drillTextSendFailed"
          : teacherSendState === "nothing-to-send"
            ? "modeBanner.drillTextNothingToSend"
            : "modeBanner.drillTextLocal";
    return (
      <div
        className={teacherSendState === "failed" ? "state-banner warning" : "state-banner teacher"}
        role="status"
      >
        <ShieldCheck size={18} />
        {t(drillKey)}
      </div>
    );
  }

  return (
    <div className="state-banner calm" role="status">
      <Headphones size={18} />
      {t("modeBanner.defaultText")}
    </div>
  );
}
