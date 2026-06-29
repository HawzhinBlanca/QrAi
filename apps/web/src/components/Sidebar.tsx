import {
  Award,
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
import { BrandMark } from "./BrandMark";

const navItems = [
  { id: "learner", label: "Learner", icon: Mic },
  { id: "teacher", label: "Teacher", icon: GraduationCap },
  { id: "scholar", label: "Scholar", icon: BookOpenCheck },
  { id: "model-ops", label: "Model Ops", icon: Microscope },
  { id: "trust", label: "Trust Ledger", icon: ShieldCheck },
  { id: "admin", label: "Internal Command", icon: Home },
  { id: "badges", label: "Badges", icon: Trophy },
  { id: "teachers", label: "Teachers", icon: Users },
  { id: "settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

export function Sidebar({ activeSection, onSectionChange }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">
        <BrandMark />
        <span>Quran AI</span>
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
            >
              <Icon size={19} strokeWidth={1.9} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="streak-panel">
        <div>
          <span>Pilot region</span>
          <strong>Kurdistan</strong>
        </div>
        <div>
          <span>Review queue</span>
          <strong>29 items</strong>
        </div>
        <div>
          <span>Trust state</span>
          <strong><Award size={16} /> Reviewed</strong>
        </div>
      </div>
    </aside>
  );
}
