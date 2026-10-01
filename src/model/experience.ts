import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BusyState, beginMutation } from "./updates";

/** The serde names of `settings::Experience`, written by hand to match. */
export type Experience = "new_to_live" | "finishes_tracks" | "mixes_for_others";

export const EXPERIENCES: { value: Experience; label: string; hint: string }[] = [
  { value: "new_to_live", label: "New to Live", hint: "I'm learning. Explain words as you go." },
  { value: "finishes_tracks", label: "I finish tracks", hint: "I know my way around. Skip the basics." },
  { value: "mixes_for_others", label: "I mix for other people", hint: "Mixing is my job. Keep it technical." },
];

/** `undefined` while Rust has not answered; `null` until she has chosen. */
export function useExperience(busy: BusyState) {
  const [experience, setExperience] = useState<Experience | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Experience | null>("get_experience")
      .then(setExperience)
      .catch((e) => setError(String(e)));
  }, []);

  const choose = useCallback(
    async (next: Experience) => {
      if (!beginMutation(busy, "settingsSave")) return;
      setError(null);
      try {
        await invoke("set_experience", { experience: next });
        setExperience(next);
      } catch (e) {
        setError(String(e));
      } finally {
        busy.settingsSave = false;
      }
    },
    [busy],
  );

  return { experience, error, choose };
}
export type ExperienceState = ReturnType<typeof useExperience>;
