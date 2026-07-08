import { useTranslation } from "react-i18next";
import type { MicState } from "../types/practice";

export function MicNotice({ micState }: { micState: MicState }) {
  const { t } = useTranslation();
  const keyByState: Record<MicState, string> = {
    idle: "micNotice.idle",
    checking: "micNotice.checking",
    ready: "micNotice.ready",
    denied: "micNotice.denied",
    unavailable: "micNotice.unavailable",
  };

  return <p className={`mic-notice ${micState}`}>{t(keyByState[micState])}</p>;
}
