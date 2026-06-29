import { ChevronDown, Globe2, ShieldCheck } from "lucide-react";

interface TopBarProps {
  title: string;
  trustLabel?: string;
}

export function TopBar({ title, trustLabel = "Scholar-gated" }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <p>{title}</p>
      </div>
      <div className="topbar-actions">
        <span className="topbar-trust">
          <ShieldCheck size={16} />
          {trustLabel}
        </span>
        <button className="language-button" type="button">
          9 languages
          <Globe2 size={16} />
        </button>
        <div className="profile-chip">
          <span>
            Soran Othman
            <small>Student</small>
          </span>
          <ChevronDown size={15} />
          <b>SO</b>
        </div>
      </div>
    </header>
  );
}
