// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAccount } from "./account";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

it("reads the account again when the window regains focus, so a finished checkout shows", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ access: "plan_required", capture: false })
    .mockResolvedValueOnce({ access: "active", capture: false, subscription_status: "trialing" });
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.view?.access).toBe("plan_required"));
  act(() => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(result.current.view?.access).toBe("active"));
});
