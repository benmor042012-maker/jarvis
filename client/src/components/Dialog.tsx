import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  describedBy?: string;
  wide?: boolean;
}

/** Modal with focus trap, Escape to close and focus restoration. */
export function Dialog({ title, onClose, children, initialFocus, describedBy, wide }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = `dlg-${title.replace(/\W+/g, "-").toLowerCase()}`;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusTarget = initialFocus?.current ?? ref.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    window.setTimeout(() => focusTarget?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose, initialFocus]);

  return (
    <div className="backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={wide ? "dialog dialog-wide" : "dialog"} role="dialog" aria-modal="true" aria-labelledby={titleId} {...(describedBy ? { "aria-describedby": describedBy } : {})}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
