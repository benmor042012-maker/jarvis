import { useCallback, useEffect, useRef, useState } from "react";

import { describeError } from "./protocol";

export type ActionPhase = "idle" | "loading" | "success" | "error";

export interface ActionState {
  phase: ActionPhase;
  error: string | null;
}

/**
 * Wraps an async handler so every button gets loading / success / error states
 * for free, with human messages for offline, timeout, denied, auth failures and
 * unexpected errors (see describeError).
 *
 * The returned runner is stable across renders — callers pass inline arrow
 * functions, and an unstable runner in an effect's dependency list would loop.
 */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, { successMs = 1800 }: { successMs?: number } = {}): [(...args: A) => Promise<boolean>, ActionState, () => void] {
  const [state, setState] = useState<ActionState>({ phase: "idle", error: null });
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(fn);
  const alive = useRef(true);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(
    () => () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    },
    [],
  );

  const run = useCallback(
    async (...args: A) => {
      window.clearTimeout(timer.current);
      setState({ phase: "loading", error: null });
      try {
        await latest.current(...args);
        if (!alive.current) return true;
        setState({ phase: "success", error: null });
        timer.current = window.setTimeout(() => {
          if (alive.current) setState({ phase: "idle", error: null });
        }, successMs);
        return true;
      } catch (err) {
        if (alive.current) setState({ phase: "error", error: describeError(err) });
        return false;
      }
    },
    [successMs],
  );

  const reset = useCallback(() => {
    setState({ phase: "idle", error: null });
  }, []);
  return [run, state, reset];
}
