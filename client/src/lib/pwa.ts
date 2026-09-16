// Installing JARVIS on a phone, and asking that phone for permission to show
// local notifications.
//
// Both depend on the browser's "secure context" rule: service workers and the
// Notification API are only available over https or from localhost. The JARVIS
// page on a phone is served over plain http from your computer's LAN address,
// so on most phones these are blocked by the browser before JARVIS is asked.
// That is stated plainly rather than hidden behind a button that does nothing.

export interface NotificationSupport {
  supported: boolean;
  permission: NotificationPermission | "unavailable";
  reason: string | null;
  fix: string | null;
}

export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    const secure = typeof window !== "undefined" && window.isSecureContext;
    return {
      supported: false,
      permission: "unavailable",
      reason: secure
        ? "This browser does not provide the Notification API."
        : `This page is served over plain http (${typeof window === "undefined" ? "" : window.location.host}), and browsers only allow notifications over https or from localhost. The browser blocks them before JARVIS is asked.`,
      fix: "Keep the JARVIS page open on the phone: the alert screen, the sound and the banner all still work there, because they are part of the page and need no permission.",
    };
  }
  return { supported: true, permission: Notification.permission, reason: null, fix: null };
}

export async function askForNotifications(): Promise<NotificationSupport> {
  const s = notificationSupport();
  if (!s.supported || s.permission === "granted" || s.permission === "denied") return s;
  try {
    await Notification.requestPermission();
  } catch {
    /* older browsers use the callback form; the state below reflects the result either way */
  }
  return notificationSupport();
}

/** Registers the offline shell. Silently does nothing where it is not allowed. */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => undefined);
  });
}

export function serviceWorkerStatus(): { active: boolean; reason: string | null } {
  if (typeof window === "undefined") return { active: false, reason: null };
  if (!("serviceWorker" in navigator)) return { active: false, reason: "This browser has no service worker support, so JARVIS cannot be installed as an app here." };
  if (!window.isSecureContext) {
    return {
      active: false,
      reason: `Installing as an app needs https or localhost; this page is ${window.location.protocol}//${window.location.host}. The page itself still works normally over your Wi-Fi — it just cannot be installed or run offline.`,
    };
  }
  return { active: !!navigator.serviceWorker.controller, reason: null };
}
