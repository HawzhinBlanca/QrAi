import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Shows a non-intrusive banner when the browser goes offline.
 * Auto-hides when connectivity is restored.
 */
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => setIsOffline(false);

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <WifiOff size={16} />
      <span>You're offline. Some features may be unavailable until connectivity is restored.</span>
    </div>
  );
}
