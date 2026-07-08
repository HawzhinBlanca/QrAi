import { useState } from "react";
import { GraduationCap, User, Lock, LogIn, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";

export function LoginScreen() {
  const { t } = useTranslation();
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
      setError(t("login.errorPasswordLength"));
      return;
    }
    let success = false;
    if (mode === "login") {
      success = await login(userId, tenantId, password);
    } else {
      success = await register(tenantId, displayName || `User-${Date.now().toString(36)}`, role, language, password, email || undefined);
    }
    if (!success) {
      setError(mode === "login" ? t("login.errorLoginFailed") : t("login.errorRegisterFailed"));
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <GraduationCap size={40} />
          <h1>{t("login.brand")}</h1>
          <p>{t("login.tagline")}</p>
        </div>

        <div className="login-tabs">
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
            type="button"
          >
            <LogIn size={16} /> {t("login.signIn")}
          </button>
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
            type="button"
          >
            <UserPlus size={16} /> {t("login.register")}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {mode === "register" && (
            <label className="login-field">
              <User size={16} />
              <input
                type="text"
                placeholder={t("login.displayNamePlaceholder")}
                aria-label={t("login.displayNameLabel")}
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
                placeholder={t("login.userIdPlaceholder")}
                aria-label={t("login.userIdLabel")}
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
              placeholder={t("login.passwordPlaceholder")}
              aria-label={t("login.passwordLabel")}
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
                placeholder={t("login.emailPlaceholder")}
                aria-label={t("login.emailLabel")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}

          <label className="login-field">
            <Lock size={16} />
            <input
              type="text"
              placeholder={t("login.institutionIdPlaceholder")}
              aria-label={t("login.institutionIdLabel")}
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
            />
          </label>

          <label className="login-field">
            <span className="sr-only">{t("login.roleLabel")}</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label={t("login.roleLabel")}>
              <option value="learner">{t("login.roleLearner")}</option>
              <option value="teacher">{t("login.roleTeacher")}</option>
              <option value="scholar">{t("login.roleScholar")}</option>
              <option value="admin">{t("login.roleAdmin")}</option>
            </select>
          </label>

          {mode === "register" && (
            <label className="login-field">
              {/* Native names, not translatable UI text (same convention as data/platform.ts's
                  supportedLanguages) -- deliberately left as-is. */}
              <span className="sr-only">{t("login.languageLabel")}</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label={t("login.languageLabel")}>
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
            {loading ? t("login.submitLoading") : mode === "login" ? t("login.submitSignIn") : t("login.submitCreateAccount")}
          </button>
        </form>

        <p className="login-hint">
          {mode === "login" ? t("login.hintSignIn") : t("login.hintRegister")}
        </p>
      </div>
    </div>
  );
}
