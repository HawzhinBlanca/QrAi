import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

import { fetchWithTimeout } from "./http";

// Dev needs an absolute URL (vite serves 5173, the API 8080); the Docker/prod build proxies /v1/
// through nginx (nginx.conf), so a relative path is required there instead — both to avoid
// bypassing that proxy and to satisfy the CSP's `connect-src 'self'`.
const API_BASE = import.meta.env.VITE_PLATFORM_API_URL || (import.meta.env.DEV ? "http://127.0.0.1:8080" : "");

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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = readStored();
    if (stored) {
      setUser(stored);
    }
  }, []);

  async function login(userId: string, tenantId: string, password: string): Promise<boolean> {
    setLoading(true);
    try {
      const response = await fetchWithTimeout(`${API_BASE}/v1/auth/login`, {
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
      const response = await fetchWithTimeout(`${API_BASE}/v1/auth/register`, {
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
