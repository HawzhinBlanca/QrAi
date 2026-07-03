import { useState } from "react";
import { GraduationCap, User, Lock, LogIn, UserPlus } from "lucide-react";
import { useAuth } from "../lib/auth";

export function LoginScreen() {
  const { login, register, loading } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [userId, setUserId] = useState("");
  const [tenantId, setTenantId] = useState("hikmah-pilot-erbil");
  const [role, setRole] = useState("learner");
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState("ar");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    let success = false;
    if (mode === "login") {
      success = await login(userId, tenantId, password);
    } else {
      success = await register(tenantId, displayName || `User-${Date.now().toString(36)}`, role, language, password, email || undefined);
    }
    if (!success) {
      setError(mode === "login" ? "Login failed. Check credentials." : "Registration failed. Tenant may not exist or email already registered.");
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <GraduationCap size={40} />
          <h1>Quran AI</h1>
          <p>Recitation intelligence for mastery</p>
        </div>

        <div className="login-tabs">
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
            type="button"
          >
            <LogIn size={16} /> Sign In
          </button>
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
            type="button"
          >
            <UserPlus size={16} /> Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {mode === "register" && (
            <label className="login-field">
              <User size={16} />
              <input
                type="text"
                placeholder="Display name"
                aria-label="Display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
          )}

          {mode === "login" && (
            <label className="login-field">
              <User size={16} />
              <input
                type="text"
                placeholder="User ID (e.g. learner-1)"
                aria-label="User ID"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
              />
            </label>
          )}

          <label className="login-field">
            <Lock size={16} />
            <input
              type="password"
              placeholder="Password (min 8 characters)"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {mode === "register" && (
            <label className="login-field">
              <User size={16} />
              <input
                type="email"
                placeholder="Email (optional)"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}

          <label className="login-field">
            <Lock size={16} />
            <input
              type="text"
              placeholder="Institution ID"
              aria-label="Institution ID"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
            />
          </label>

          <label className="login-field">
            <span className="sr-only">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="learner">Learner</option>
              <option value="teacher">Teacher</option>
              <option value="scholar">Scholar</option>
              <option value="admin">Admin</option>
            </select>
          </label>

          {mode === "register" && (
            <label className="login-field">
              <span className="sr-only">Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
                <option value="ar">العربية</option>
                <option value="ckb">کوردیی ناوەندی</option>
                <option value="en">English</option>
                <option value="tr">Türkçe</option>
                <option value="ur">اردو</option>
              </select>
            </label>
          )}

          {error && <p className="login-error" role="alert">{error}</p>}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <p className="login-hint">
          {mode === "login"
            ? "Sign in with your User ID and password."
            : "Create an account with a secure password (8+ characters)."}
        </p>
      </div>
    </div>
  );
}
