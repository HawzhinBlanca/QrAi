import {
  BookOpenCheck,
  GraduationCap,
  Home,
  Mic,
  Microscope,
  Settings,
  ShieldCheck,
  Trophy,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandMark } from "./BrandMark";

const navItems = [
  { id: "learner", labelKey: "sidebar.nav.learner", icon: Mic },
  { id: "teacher", labelKey: "sidebar.nav.teacher", icon: GraduationCap },
  { id: "scholar", labelKey: "sidebar.nav.scholar", icon: BookOpenCheck },
  { id: "model-ops", labelKey: "sidebar.nav.modelOps", icon: Microscope },
  { id: "trust", labelKey: "sidebar.nav.trustLedger", icon: ShieldCheck },
  { id: "admin", labelKey: "sidebar.nav.internalCommand", icon: Home },
  { id: "badges", labelKey: "sidebar.nav.badges", icon: Trophy },
  { id: "teachers", labelKey: "sidebar.nav.teachers", icon: Users },
  { id: "settings", labelKey: "sidebar.nav.settings", icon: Settings },
] as const;

interface SidebarProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

export function Sidebar({ activeSection, onSectionChange }: SidebarProps) {
  const { t } = useTranslation();
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">
        <BrandMark />
        <span>{t("sidebar.brand")}</span>
      </div>

      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={activeSection === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => onSectionChange(item.id)}
              type="button"
              aria-current={activeSection === item.id ? "page" : undefined}
            >
              <Icon size={19} strokeWidth={1.9} />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {/* Only real facts here. Two rows were removed as fabrications: "Review queue: 29 items"
          (a hardcoded count no backend ever produced — a real queue count belongs to the
          role-gated teacher surface, SHIP_PLAN P4.10) and "Trust state: Reviewed" (a static
          claim; the TopBar already shows the real per-section trust label). */}
      <div className="streak-panel">
        <div>
          <span>{t("sidebar.pilotRegion")}</span>
          <strong>{t("sidebar.pilotRegionValue")}</strong>
        </div>
      </div>
    </aside>
  );
}
