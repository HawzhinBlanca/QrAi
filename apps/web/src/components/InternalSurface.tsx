import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import type { SupportedLanguageCode } from "../types/platform";
import type { AppSection } from "../types/practice";

const PlatformCommand = lazy(() => import("./PlatformCommand").then(m => ({ default: m.PlatformCommand })));

// Plain function, no React context to call useTranslation() from -- returns a translation KEY.
function internalTitleKey(section: AppSection): string {
  switch (section) {
    case "teacher":
      return "internalSurface.titleTeacher";
    case "scholar":
      return "internalSurface.titleScholar";
    case "model-ops":
      return "internalSurface.titleModelOps";
    case "trust":
      return "internalSurface.titleTrust";
    case "badges":
      return "internalSurface.titleBadges";
    case "teachers":
      return "internalSurface.titleTeachers";
    case "settings":
      return "internalSurface.titleSettings";
    case "admin":
      return "internalSurface.titleAdmin";
    case "learner":
      return "internalSurface.titleLearner";
  }
}

export function InternalSurface({
  tenantId,
  authToken,
  activeLanguage,
  activeSection,
  activeTab,
  onLanguageChange,
  onTabChange,
  onOpenCommand,
  onSectionChange,
}: {
  tenantId: string;
  authToken?: string;
  activeLanguage: SupportedLanguageCode;
  activeSection: AppSection;
  activeTab: string;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  onTabChange: (tab: string) => void;
  onOpenCommand: (tab: string) => void;
  onSectionChange: (section: string) => void;
}) {
  const { t } = useTranslation();
  if (activeSection !== "admin") {
    return (
      <section className="internal-placeholder" aria-label={t("internalSurface.ariaLabel")}>
        <h1>{t(internalTitleKey(activeSection))}</h1>
        <p>{t("internalSurface.placeholderBody")}</p>
        {/* onTabChange alone only set activeTab — it never switched activeSection to "admin", so
            this button did nothing observable: InternalSurface stayed on this same placeholder
            since its early-return only checks activeSection. onOpenCommand switches both. */}
        <button className="secondary-action" onClick={() => onOpenCommand(activeSection === "model-ops" ? "model-ops" : "review")} type="button">
          {t("internalSurface.openRelatedCommandTab")}
        </button>
      </section>
    );
  }

  return (
    <Suspense fallback={<div className="internal-placeholder"><p>{t("internalSurface.loadingConsole")}</p></div>}>
      <PlatformCommand
        tenantId={tenantId}
        authToken={authToken}
        activeLanguage={activeLanguage}
        activeTab={activeTab}
        onLanguageChange={onLanguageChange}
        onTabChange={onTabChange}
        activeSection={activeSection}
        onSectionChange={onSectionChange}
      />
    </Suspense>
  );
}
