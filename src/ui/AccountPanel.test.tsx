// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccountPanel } from "./AccountPanel";
import { AccountState } from "../model/account";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const account: AccountState = {
  view: { access: "active", capture: false, email: "producer@example.com", remaining_micro_usd: 5_000_000 },
  error: null, refresh: async () => {}, change: () => {}, observe: () => () => {},
};

it("says deleting the account is permanent, marks the button as dangerous, and starts on Cancel", () => {
  render(<AccountPanel account={account} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete account…" }));
  expect(screen.getByText(/This can't be undone/)).toBeTruthy();
  expect(screen.getByText(/you'd need a new invitation to come back/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete my account" }).className).toContain("account__danger");
  // A reflexive Enter cancels instead of deleting.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
});
