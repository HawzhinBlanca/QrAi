import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface AuthUser {
  userId: string;
  tenantId: string;
  role: string;
  displayName: string;
  token: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  login: (userId: string, tenantId: string, password: string) => Promise<boolean>;
  register: (tenantId: string, displayName: string, role: string, language: string, password: string, email?: string) => Promise<boolean>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "quran-ai-auth";

// ── DEV-ONLY login bypass ───────────────────────────────────────────────────
// Auto-signs-in a throwaway dev account so development skips the login screen.
// `import.meta.env.DEV` is false in production builds, so this is automatically
// excluded from `vite build` — production keeps real auth. To use the real login
// screen in dev: `localStorage.setItem("auth-bypass","off")` then reload.
// Remove this block (and devAutoLogin) when production auth ships.
const DEV_BYPASS = {
  tenantId: "hikmah-pilot-erbil",
  email: "dev@bypass.local",
  password: "dev-bypass-12345",
  displayName: "Dev User",
  role: "learner",
  language: "en",
};

function bypassEnabled(): boolean {
  return import.meta.env.DEV && localStorage.getItem("auth-bypass") !== "off";
}

function readStored(): AuthUser | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  // Start in "loading" when a bypass sign-in is pending, so the login screen
  // never flashes before the dev session is established.
  const [loading, setLoading] = useState<boolean>(() => bypassEnabled() && !readStored());

  useEffect(() => {
    const stored = readStored();
    if (stored) {
      setUser(stored);
      return;
    }
    if (bypassEnabled()) {
      void devAutoLogin();
    }
  }, []);

  async function login(userId: string, tenantId: string, password: string): Promise<boolean> {
    setLoading(true);
    try {
      const apiBase = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";
      const response = await fetch(`${apiBase}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, tenantId, password }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      const authUser: AuthUser = {
        userId: data.userId,
        tenantId: data.tenantId,
        role: data.role,
        displayName: data.displayName,
        token: data.token,
      };
      setUser(authUser);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function register(tenantId: string, displayName: string, role: string, language: string, password: string, email?: string): Promise<boolean> {
    setLoading(true);
    try {
      const apiBase = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";
      const response = await fetch(`${apiBase}/v1/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, displayName, role, language, password, email }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      const authUser: AuthUser = {
        userId: data.userId,
        tenantId: data.tenantId,
        role: data.role,
        displayName,
        token: data.token,
      };
      setUser(authUser);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }

  // DEV-ONLY: silently establish a real backend session for a throwaway dev
  // account (login-by-email, or register on first run) so the app is usable
  // without the login screen. Best-effort: on any failure we fall back to login.
  async function devAutoLogin(): Promise<void> {
    setLoading(true);
    try {
      const apiBase = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";
      const post = (path: string, body: unknown) =>
        fetch(`${apiBase}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const persist = (data: AuthUser) => {
        const authUser: AuthUser = {
          userId: data.userId,
          tenantId: data.tenantId,
          role: data.role,
          displayName: data.displayName || DEV_BYPASS.displayName,
          token: data.token,
        };
        setUser(authUser);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
      };
      const { tenantId, email, password, displayName, role, language } = DEV_BYPASS;
      let res = await post("/v1/auth/login", { email, tenantId, password });
      if (!res.ok) {
        res = await post("/v1/auth/register", {
          tenantId,
          displayName,
          role,
          language,
          password,
          email,
        });
        if (!res.ok) res = await post("/v1/auth/login", { email, tenantId, password });
      }
      if (res.ok) persist((await res.json()) as AuthUser);
    } catch {
      /* best-effort; falls back to the login screen */
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setUser(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
