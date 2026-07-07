import { Suspense, lazy } from "react";
import type { SupportedLanguageCode } from "../types/platform";
import type { AppSection } from "../types/practice";

const PlatformCommand = lazy(() => import("./PlatformCommand").then(m => ({ default: m.PlatformCommand })));

function internalTitle(section: AppSection): string {
  switch (section) {
    case "teacher":
      return "Teacher Review";
    case "scholar":
      return "Scholar Review";
    case "model-ops":
      return "Model Ops";
    case "trust":
      return "Trust Ledger";
    case "badges":
      return "Learner Badges";
    case "teachers":
      return "Teachers";
    case "settings":
      return "Settings";
    case "admin":
      return "Internal Command";
    case "learner":
      return "Learner";
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
}: {
  tenantId: string;
  authToken?: string;
  activeLanguage: SupportedLanguageCode;
  activeSection: AppSection;
  activeTab: string;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  onTabChange: (tab: string) => void;
  onOpenCommand: (tab: string) => void;
}) {
  if (activeSection !== "admin") {
    return (
      <section className="internal-placeholder" aria-label="Internal surface">
        <h1>{internalTitle(activeSection)}</h1>
        <p>Internal review tools stay out of the learner path. Use Internal Command for the full platform console.</p>
        {/* onTabChange alone only set activeTab — it never switched activeSection to "admin", so
            this button did nothing observable: InternalSurface stayed on this same placeholder
            since its early-return only checks activeSection. onOpenCommand switches both. */}
        <button className="secondary-action" onClick={() => onOpenCommand(activeSection === "model-ops" ? "model-ops" : "review")} type="button">
          Open related command tab
        </button>
      </section>
    );
  }

  return (
    <Suspense fallback={<div className="internal-placeholder"><p>Loading platform console…</p></div>}>
      <PlatformCommand
        tenantId={tenantId}
        authToken={authToken}
        activeLanguage={activeLanguage}
        activeTab={activeTab}
        onLanguageChange={onLanguageChange}
        onTabChange={onTabChange}
      />
    </Suspense>
  );
}
