import { ChevronDown, Globe2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { supportedLanguages } from "../data/platform";
import type { SupportedLanguageCode } from "../types/platform";

interface TopBarProps {
  title: string;
  trustLabel?: string;
  activeLanguage: SupportedLanguageCode;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  displayName?: string;
  roleLabel?: string;
  onLogout?: () => void;
}

export function TopBar({
  title,
  trustLabel,
  activeLanguage,
  onLanguageChange,
  displayName,
  roleLabel,
  onLogout,
}: TopBarProps) {
  const { t } = useTranslation();
  const resolvedDisplayName = displayName ?? t("topBar.displayNameDefault");
  const initials = resolvedDisplayName
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="topbar">
      <div>
        <p>{title}</p>
      </div>
      <div className="topbar-actions">
        <span className="topbar-trust">
          <ShieldCheck size={16} />
          {trustLabel ?? t("topBar.trustLabelDefault")}
        </span>
        {/* Was a plain <button> with no onClick at all — the ONLY working language switcher was
            PlatformCommand's own <select>, reachable only via the internal admin console.
            Learner-facing screens (rendered through this same TopBar) had no way to change
            language at all. Reuses the identical pattern (native <select>, visible via the
            browser's own rendering, driven by the same activeLanguage/onLanguageChange state
            App.tsx already threads to PlatformCommand). */}
        <label className="language-button" aria-label={t("topBar.language")}>
          <Globe2 size={16} />
          <select value={activeLanguage} onChange={(event) => onLanguageChange(event.target.value as SupportedLanguageCode)}>
            {supportedLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.nativeName}
              </option>
            ))}
          </select>
        </label>
        {/* Was a plain <div> with a ChevronDown icon implying a dropdown that didn't exist --
            no onClick, no menu, no logout. onLogout is only set by the caller once real
            authentication is active (VITE_REQUIRE_LOGIN=1); in the default bypass-login mode
            there is no real session to log out of, so the chip stays a non-interactive
            <button disabled>, matching its visual affordance to its actual behavior. */}
        <button
          className="profile-chip"
          type="button"
          onClick={onLogout}
          disabled={!onLogout}
          aria-label={onLogout ? t("topBar.logout") : undefined}
        >
          <span>
            {resolvedDisplayName}
            <small>{roleLabel ?? t("topBar.roleLabelDefault")}</small>
          </span>
          <ChevronDown size={15} />
          <b>{initials}</b>
        </button>
      </div>
    </header>
  );
}
