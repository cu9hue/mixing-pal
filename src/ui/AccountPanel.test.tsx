// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountPanel } from "./AccountPanel";
import { invoke } from "@tauri-apps/api/core";
import { AccountState, AccountView } from "../model/account";
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
  expect(screen.getByText(/any subscription is canceled with no refund/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete my account" }).className).toContain("account__danger");
  // A reflexive Enter cancels instead of deleting.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
});

const signedIn = (view: Partial<AccountView>): AccountState =>
  ({ ...account, view: { access: "active", capture: false, email: "producer@example.com", ...view } });

it("offers both plans with a free trial, and opens Checkout for the one she picks", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  render(<AccountPanel account={signedIn({ access: "plan_required", trial_available: true })} />);
  expect(screen.getAllByRole("button", { name: "Start 7-day free trial" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Start 7-day free trial" })[1]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "checkout", plan: "pro" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
});

it("says Subscribe when no trial is left", () => {
  render(<AccountPanel account={signedIn({ access: "plan_required", trial_available: false })} />);
  expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(2);
});

it("lets a trialist who ran out start her plan now", async () => {
  const change = vi.fn();
  vi.mocked(invoke).mockResolvedValue({ access: "active", capture: false, subscription_status: "active" });
  render(<AccountPanel account={{ ...signedIn({ subscription_status: "trialing", plan: "starter", can_ask: false, remaining_micro_usd: 100 }), change }} />);
  fireEvent.click(screen.getByRole("button", { name: "Start my plan now" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "start-now" }));
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ subscription_status: "active" }));
});

it("offers Pro to a Starter member who ran out, and only the reset date to Pro", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "active", plan: "starter", can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 20) })} />);
  expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  cleanup();
  render(<AccountPanel account={signedIn({ subscription_status: "active", plan: "pro", can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 20) })} />);
  expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  expect(screen.getByText(/It resets on/)).toBeTruthy();
});

it("warns when a payment failed, and opens the Portal from Manage subscription", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  render(<AccountPanel account={signedIn({ subscription_status: "past_due", plan: "starter", manage: true, remaining_micro_usd: 1_000_000, period_end: Date.now() + 86_400_000 })} />);
  expect(screen.getByRole("alert").textContent).toContain("Your payment didn't go through.");
  expect(screen.getByRole("alert").textContent).toContain("Update your card to keep access past ");
  fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "portal" }));
});

it("names the plan, a trial, and free access", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "trialing", plan: "pro", remaining_micro_usd: 1_000_000 })} />);
  expect(screen.getByText(/Pro · free trial/)).toBeTruthy();
  cleanup();
  render(<AccountPanel account={signedIn({ comp: true, remaining_micro_usd: 8_000_000 })} />);
  expect(screen.getByText(/Free access/)).toBeTruthy();
});

it("a comped account that ran out shows when it resets, with no button", () => {
  render(<AccountPanel account={signedIn({ comp: true, can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 20) })} />);
  expect(screen.getByText(/It resets on/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start my plan now" })).toBeNull();
  expect(document.querySelector(".account__summary")?.textContent).not.toContain("until");
});

it("the browser note clears once the account changes", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  const { rerender } = render(<AccountPanel account={signedIn({ access: "plan_required", trial_available: true })} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Start 7-day free trial" })[0]);
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
  rerender(<AccountPanel account={signedIn({ subscription_status: "trialing", plan: "starter", remaining_micro_usd: 1_000_000 })} />);
  await waitFor(() => expect(screen.queryByText(/Finish in your browser/)).toBeNull());
});

it("the browser note clears when only the plan's cancellation changes", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  const active = { subscription_status: "active", plan: "starter", manage: true, remaining_micro_usd: 1_000_000, period_end: Date.UTC(2026, 10, 20) } as const;
  const { rerender } = render(<AccountPanel account={signedIn(active)} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
  rerender(<AccountPanel account={signedIn({ ...active })} />);
  expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
  rerender(<AccountPanel account={signedIn({ ...active, cancel_at_period_end: true })} />);
  await waitFor(() => expect(screen.queryByText(/Finish in your browser/)).toBeNull());
});
