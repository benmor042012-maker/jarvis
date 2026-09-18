// Which screen the window shows: the Command Center with its side panels, or
// the orb alone. Remembered per browser; nothing else depends on it.
const LAYOUT_KEY = "jarvis.layout";

export type Layout = "center" | "focus";

export function loadLayout(): Layout {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === "focus" ? "focus" : "center";
  } catch {
    return "center";
  }
}

export function saveLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* forgotten on reload, nothing else */
  }
}
