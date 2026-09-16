import { useState } from "react";

import { askForNotifications, notificationSupport, serviceWorkerStatus } from "../lib/pwa";
import { unlockAudio } from "../lib/sound";
import { useJarvis } from "../state/jarvisStore";

/**
 * How alerts reach the device you are holding. On the phone this is the whole
 * story: the page is connected to your computer over your own Wi-Fi and the
 * alert arrives on that connection. Nothing is subscribed to a push service,
 * because there is none.
 */
export function DeviceAlerts() {
  const label = useJarvis((s) => s.alertLabel);
  const [support, setSupport] = useState(notificationSupport());
  const sw = serviceWorkerStatus();

  return (
    <section className="device-alerts">
      <h3>Alerts on this device</h3>
      <p className="pill pill-model">{label}</p>
      <ul className="list">
        <li>
          <strong>On this screen:</strong> always, while the JARVIS page is open. It needs no permission.
        </li>
        <li>
          <strong>Sound:</strong> after you have touched the page once — browsers refuse to play audio before that.{" "}
          <button type="button" className="btn btn-ghost btn-small" onClick={() => { unlockAudio(); }}>
            Enable sound here
          </button>
        </li>
        <li>
          <strong>System notification:</strong>{" "}
          {support.supported ? (
            support.permission === "granted" ? (
              "allowed on this device."
            ) : support.permission === "denied" ? (
              "refused in this browser's site settings. Re-allow notifications for this page to turn them back on."
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => {
                  void askForNotifications().then(setSupport);
                }}
              >
                Allow notifications
              </button>
            )
          ) : (
            support.reason
          )}
          {!support.supported && support.fix && <div className="help">{support.fix}</div>}
        </li>
        <li>
          <strong>Install as an app:</strong> {sw.reason ?? (sw.active ? "installed and cached, so the page opens even if the computer is asleep." : "available from your browser's “Add to home screen” menu.")}
        </li>
      </ul>
      <p className="help">No Telegram, WhatsApp, SMS, email, Firebase or Apple push is used anywhere. If your phone is not on the same Wi-Fi, it simply does not get the alert — JARVIS will not route it through anything else.</p>
    </section>
  );
}
