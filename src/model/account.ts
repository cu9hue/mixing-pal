import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AccountView {
  access: "signed_out" | "invitation_required" | "active" | "expired" | "revoked" | "development";
  id?: string;
  email?: string;
  remaining_micro_usd?: number;
  can_ask?: boolean;
  reserved_micro_usd?: number;
  service_paused?: boolean;
  period_end?: number;
  capture: boolean;
  consent_epoch?: number;
  consent_version?: string;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

export function canAsk(view: AccountView | null): boolean {
  return view?.access === "development" || (view?.access === "active" && view.can_ask !== false && (view.remaining_micro_usd ?? 0) > 0);
}

export function useAccount() {
  const [view, setView] = useState<AccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const observe = useCallback(() => {
    const started = generation.current;
    return (next: AccountView) => {
      if (started !== generation.current) return;
      setView((current) => current && current.id === next.id && (current.consent_epoch ?? 0) > (next.consent_epoch ?? 0)
        ? { ...next, capture: current.capture, consent_epoch: current.consent_epoch } : next);
    };
  }, []);
  const refresh = useCallback(() => {
    setError(null);
    const update = observe();
    const started = generation.current;
    return invoke<AccountView>("account_status").then(update).catch((e) => {
      if (started === generation.current) setError(errorMessage(e));
    });
  }, [observe]);
  const change = useCallback((next: AccountView) => { generation.current++; setView(next); setError(null); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const waiting = view?.access === "active" && ((view.reserved_micro_usd ?? 0) > 0 || view.service_paused);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  return { view, error, refresh, change, observe };
}

export type AccountState = ReturnType<typeof useAccount>;
