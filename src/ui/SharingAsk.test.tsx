// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AccountState, AccountView } from "../model/account";
import { asksToShare, SharingAsk } from "./SharingAsk";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const unchosen: AccountView = { access: "active", capture: false, sharing_chosen: false };
const state = (change = vi.fn()): AccountState => ({ view: unchosen, error: null, refresh: async () => {}, change, observe: () => () => {} });

it("asks only a member with access who has rated a move and never chose", () => {
  expect(asksToShare(unchosen, true)).toBe(true);
  expect(asksToShare(unchosen, false)).toBe(false);
  expect(asksToShare({ ...unchosen, sharing_chosen: true }, true)).toBe(false);
  // An older server that does not report the choice is never asked.
  expect(asksToShare({ access: "active", capture: false }, true)).toBe(false);
  for (const access of ["development", "plan_required", "expired", "revoked", "signed_out"] as const) {
    expect(asksToShare({ ...unchosen, access }, true)).toBe(false);
  }
  expect(asksToShare(null, true)).toBe(false);
});

it.each([["Share", true], ["No thanks", false]] as const)("%s records the choice", async (label, enabled) => {
  const chosen = { ...unchosen, sharing_chosen: true, capture: enabled };
  vi.mocked(invoke).mockReset().mockResolvedValue(chosen);
  const change = vi.fn();
  render(<SharingAsk account={state(change)} />);
  expect(screen.getByRole("region", { name: "Help me get better at this?" })).toBeTruthy();
  expect(screen.getByText(/We delete them after 30 days and never use them to train AI\./)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: label })); });
  expect(vi.mocked(invoke).mock.calls).toEqual([["account_consent", { enabled }]]);
  expect(change).toHaveBeenCalledWith(chosen);
});

it("keeps the question and says so when the choice cannot be saved", async () => {
  vi.mocked(invoke).mockReset().mockRejectedValue({ code: "network", message: "Mixing Pal could not be reached." });
  const change = vi.fn();
  render(<SharingAsk account={state(change)} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Share" })); });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).not.toBe("");
});
