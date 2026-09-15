import { useMemo } from "react";

import type { OrbState } from "../state/jarvisStore";

interface Props {
  state: OrbState;
  statusText: string;
  subtext?: string;
}

// Deterministic particle field so renders stay stable (and reduced motion is calm).
function useParticles(count: number) {
  return useMemo(() => {
    const pts: { x: number; y: number; r: number; o: number }[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 62 + rnd() * 34;
      pts.push({ x: 100 + Math.cos(a) * d, y: 100 + Math.sin(a) * d, r: 0.5 + rnd() * 1.1, o: 0.25 + rnd() * 0.6 });
    }
    return pts;
  }, [count]);
}

function ticks(radius: number, count: number, len: number, every = 1) {
  const out: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const major = i % every === 0;
    const l = major ? len : len * 0.5;
    out.push({ x1: 100 + Math.cos(a) * radius, y1: 100 + Math.sin(a) * radius, x2: 100 + Math.cos(a) * (radius - l), y2: 100 + Math.sin(a) * (radius - l), major });
  }
  return out;
}

export function JarvisOrb({ state, statusText, subtext }: Props) {
  const particles = useParticles(46);
  const outerTicks = useMemo(() => ticks(96, 72, 4, 6), []);
  const innerTicks = useMemo(() => ticks(60, 36, 3, 3), []);
  const showWave = state === "listening" || state === "speaking";

  return (
    <div className="orb-wrap" data-state={state}>
      <div className="orb" data-state={state} role="img" aria-label={`JARVIS status: ${statusText.toLowerCase()}`}>
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <defs>
            <radialGradient id="disc" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="#0b2e52" />
              <stop offset="70%" stopColor="#071a33" />
              <stop offset="100%" stopColor="#030b18" />
            </radialGradient>
            <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
              <stop offset="60%" stopColor="#377dff" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#377dff" stopOpacity="0" />
            </radialGradient>
          </defs>

          <g className="particles">
            {particles.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={p.r} fill="#8aa8ff" opacity={p.o} />
            ))}
          </g>

          <g className="ring-outer">
            <circle cx="100" cy="100" r="96" fill="none" className="accent" strokeWidth="0.6" opacity="0.55" />
            {outerTicks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className="accent" strokeWidth={t.major ? 1 : 0.5} opacity={t.major ? 0.9 : 0.45} />
            ))}
            <circle cx="100" cy="4" r="1.8" className="accent-fill" />
            <circle cx="196" cy="100" r="1.8" className="accent-fill" opacity="0.7" />
          </g>

          <g className="ring-mid">
            <circle cx="100" cy="100" r="80" fill="none" stroke="#377dff" strokeWidth="0.8" strokeDasharray="28 10 6 10" opacity="0.7" />
            <circle cx="100" cy="100" r="74" fill="none" className="accent" strokeWidth="0.4" strokeDasharray="1.5 6" opacity="0.6" />
          </g>

          <g className="ring-inner">
            <circle cx="100" cy="100" r="60" fill="none" className="accent" strokeWidth="0.8" opacity="0.8" />
            {innerTicks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className="accent" strokeWidth="0.6" opacity={t.major ? 0.9 : 0.4} />
            ))}
            <path d="M 100 40 A 60 60 0 0 1 160 100" fill="none" className="accent" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
          </g>

          <g className="core">
            <circle cx="100" cy="100" r="58" fill="url(#coreGlow)" className="accent-color" />
            <circle cx="100" cy="100" r="46" fill="url(#disc)" stroke="#0b2e52" strokeWidth="1" />
            <circle cx="100" cy="100" r="46" fill="none" className="accent" strokeWidth="0.5" opacity="0.5" />
            <circle cx="100" cy="100" r="6" className="accent-fill" opacity="0.9" />
            <circle cx="100" cy="100" r="12" fill="none" className="accent" strokeWidth="0.6" opacity="0.7" />
          </g>

          {state === "emergency" && (
            <g className="halt" aria-hidden="true">
              <line x1="62" y1="62" x2="138" y2="138" className="accent" strokeWidth="5" strokeLinecap="round" opacity="0.85" />
              <line x1="138" y1="62" x2="62" y2="138" className="accent" strokeWidth="5" strokeLinecap="round" opacity="0.85" />
            </g>
          )}
        </svg>

        {showWave && (
          <div className="waveform" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <div className="status">
        <div className="status-title">J.A.R.V.I.S</div>
        <div className="status-line" role="status" aria-live="polite">
          {statusText}
        </div>
        {subtext && <p className="status-sub">{subtext}</p>}
      </div>
    </div>
  );
}
