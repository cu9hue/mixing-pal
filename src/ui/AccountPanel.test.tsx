// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountPanel } from "./AccountPanel";
import { invoke } from "@tauri-apps/api/core";
import { AccountState, AccountView, useAccount } from "../model/account";
import { useState } from "react";
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
const day = (time: number) => new Date(time).toLocaleDateString();
const planLine = () => document.querySelector(".account__summary")?.firstElementChild?.textContent;

it("the summary leads with the plan line, then the email", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "active", plan: "starter", remaining_micro_usd: 1_000_000, period_end: Date.UTC(2026, 10, 8) })} />);
  const lines = document.querySelector(".account__summary")!.children;
  expect(lines[0].textContent).toBe(`Starter · resets ${day(Date.UTC(2026, 10, 8))}`);
  expect(lines[1].textContent).toBe("producer@example.com");
});

it("Sign out and Delete account… are quiet links beside the one Manage subscription button", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "active", plan: "starter", manage: true, remaining_micro_usd: 1_000_000 })} />);
  const manage = screen.getByRole("button", { name: "Manage subscription" });
  const signOut = screen.getByRole("button", { name: "Sign out" });
  const remove = screen.getByRole("button", { name: "Delete account…" });
  expect(manage.className).not.toContain("account__link");
  expect(signOut.className).toContain("account__link");
  expect(remove.className).toContain("account__link");
  expect(signOut.parentElement).toBe(manage.parentElement);
  expect(remove.parentElement).toBe(manage.parentElement);
});

const signedOut = (signup?: "open" | "invite"): AccountState =>
  ({ ...account, view: { access: "signed_out", capture: false, ...(signup ? { signup } : {}) } });
const OPEN = ["Sign in with your email.", "Enter your email", "If this email can sign in, your code is on its way."];
const INVITE = ["Sign in with the email your invite came to.", "Enter the email from your invitation",
  "If your email has an invitation, your code is on its way."];

it.each([["open", OPEN], ["invite", INVITE], [undefined, INVITE]] as const)("words sign-in for %s sign-up", async (signup, [subtitle, placeholder, sent]) => {
  vi.mocked(invoke).mockResolvedValue(null);
  render(<AccountPanel account={signedOut(signup)} />);
  expect(screen.getByText(subtitle)).toBeTruthy();
  const email = screen.getByLabelText("Email");
  expect(email.getAttribute("placeholder")).toBe(placeholder);
  fireEvent.change(email, { target: { value: "producer@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(sent)).toBeTruthy();
});

it("offers both plans as one choice with Starter picked, and opens Checkout for the one the member picks", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  render(<AccountPanel account={signedIn({ access: "plan_required", trial_available: true })} />);
  expect(screen.getByRole("group", { name: /Pick a plan/ })).toBeTruthy();
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  expect((screen.getByRole("radio", { name: /^Starter/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getAllByRole("button", { name: "Start 7-day free trial" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: /^Pro/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start 7-day free trial" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "checkout", plan: "pro" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
});

it("says Subscribe when no trial is left", () => {
  render(<AccountPanel account={signedIn({ access: "plan_required", trial_available: false })} />);
  expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Start 7-day free trial" })).toBeNull();
});

it("lets a trialist who ran out start their plan now", async () => {
  const change = vi.fn();
  vi.mocked(invoke).mockResolvedValue({ access: "active", capture: false, subscription_status: "active" });
  render(<AccountPanel account={{ ...signedIn({ subscription_status: "trialing", plan: "starter", can_ask: false, remaining_micro_usd: 100 }), change }} />);
  fireEvent.click(screen.getByRole("button", { name: "Start my plan now" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "start-now" }));
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ subscription_status: "active" }));
});

it("keeps the plan line short when the allowance is used up: the lines below say so", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "trialing", plan: "pro", can_ask: false, remaining_micro_usd: 0, period_end: Date.UTC(2026, 10, 1) })} />);
  expect(planLine()).toBe(`Pro · free trial · trial ends ${day(Date.UTC(2026, 10, 1))}`);
  expect(screen.getByText(/cannot cover another request/)).toBeTruthy();
});

it("offers Pro to a Starter member who ran out, and only the plan line's reset date to Pro", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "active", plan: "starter", can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 20) })} />);
  expect(screen.getByRole("button", { name: "Upgrade to Pro" })).toBeTruthy();
  cleanup();
  render(<AccountPanel account={signedIn({ subscription_status: "active", plan: "pro", can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 20) })} />);
  expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  expect(planLine()).toContain(`resets ${day(Date.UTC(2026, 10, 20))}`);
  expect(screen.queryByText(/It resets on/)).toBeNull();
});

it("warns when a payment failed, and opens the Portal from Manage subscription", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  render(<AccountPanel account={signedIn({ subscription_status: "past_due", plan: "starter", manage: true, remaining_micro_usd: 1_000_000, period_end: Date.now() + 86_400_000 })} />);
  expect(screen.getByRole("alert").textContent).toContain("Your payment didn't go through.");
  expect(screen.getByRole("alert").textContent).toContain("Update your card to keep access past ");
  fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "portal" }));
});

it("a failed payment says how long access lasts, not when the plan resets", () => {
  const end = Date.UTC(2026, 10, 20);
  render(<AccountPanel account={signedIn({ subscription_status: "past_due", plan: "starter", manage: true, remaining_micro_usd: 1_000_000, period_end: end })} />);
  const summary = document.querySelector(".account__summary")?.textContent;
  expect(summary).toContain(`access until ${new Date(end).toLocaleDateString()}`);
  expect(summary).not.toContain("resets");
});

it("names the plan, a trial, and free access", () => {
  render(<AccountPanel account={signedIn({ subscription_status: "trialing", plan: "pro", remaining_micro_usd: 1_000_000 })} />);
  expect(screen.getByText(/Pro · free trial/)).toBeTruthy();
  cleanup();
  render(<AccountPanel account={signedIn({ comp: true, remaining_micro_usd: 8_000_000 })} />);
  expect(screen.getByText(/Free access/)).toBeTruthy();
});

it("a comped account that ran out shows when it resets on the plan line, with no button", () => {
  render(<AccountPanel account={signedIn({ comp: true, can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 20) })} />);
  expect(planLine()).toBe(`Free access · resets ${day(Date.UTC(2026, 10, 20))}`);
  expect(screen.queryByText(/It resets on/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start my plan now" })).toBeNull();
  expect(document.querySelector(".account__summary")?.textContent).not.toContain("until");
});

it("the browser note clears once the account changes", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  const { rerender } = render(<AccountPanel account={signedIn({ access: "plan_required", trial_available: true })} />);
  fireEvent.click(screen.getByRole("button", { name: "Start 7-day free trial" }));
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

it("while the browser note shows, the account is read every 5 seconds for 2 minutes, then the note clears", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue({ opened: true });
    const refresh = vi.fn(async () => {});
    render(<AccountPanel account={{ ...signedIn({ access: "plan_required", trial_available: true }), refresh }} />);
    fireEvent.click(screen.getByRole("button", { name: "Start 7-day free trial" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(110_000); });
    expect(refresh).toHaveBeenCalledTimes(23);
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(refresh).toHaveBeenCalledTimes(24);
    expect(screen.queryByText(/Finish in your browser/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refresh).toHaveBeenCalledTimes(24);
  } finally { vi.useRealTimers(); }
});

it("opens the invoice page for an upgrade and shows the browser note instead of changing the account", async () => {
  const change = vi.fn();
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  render(<AccountPanel account={{ ...signedIn({ subscription_status: "active", plan: "starter", can_ask: false, remaining_micro_usd: 100 }), change }} />);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
});

it("a start-now that opens the invoice page keeps polling, though the account it reads first has changed", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue({ opened: true });
    const trialing: AccountView = { access: "active", capture: false, email: "producer@example.com", subscription_status: "trialing",
      plan: "starter", can_ask: false, remaining_micro_usd: 100, period_end: Date.UTC(2026, 10, 27) };
    // The proxy applied the declined start-now before it answered: the next read is past due, with a new period end.
    const declined: AccountView = { ...trialing, subscription_status: "past_due", period_end: Date.UTC(2026, 11, 4) };
    const refresh = vi.fn();
    function Harness() {
      const [view, setView] = useState(trialing);
      refresh.mockImplementation(async () => setView(declined));
      return <AccountPanel account={{ ...account, view, refresh }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Start my plan now" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

it("a plan set to end says it ends on the plan line, not that it resets", () => {
  const end = Date.UTC(2026, 10, 20);
  const view = { subscription_status: "active", plan: "pro", can_ask: false, remaining_micro_usd: 100, period_end: end } as const;
  render(<AccountPanel account={signedIn({ ...view, cancel_at_period_end: true })} />);
  expect(planLine()).toBe(`Pro · ends ${day(end)}`);
  expect(screen.queryByText(/Your plan ends on/)).toBeNull();
  expect(screen.queryByText(/resets/)).toBeNull();
});

const active = { subscription_status: "active", plan: "starter", manage: true, remaining_micro_usd: 1_000_000, period_end: Date.UTC(2026, 10, 20) } as const;
const openPortal = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};

it("a second browser trip polls once per tick and restarts the 2-minute window", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue({ opened: true });
    const refresh = vi.fn(async () => {});
    render(<AccountPanel account={{ ...signedIn(active), refresh }} />);
    await openPortal();
    await openPortal();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(105_000); });
    await openPortal();
    refresh.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(119_000); });
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(23);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByText(/Finish in your browser/)).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(24);
  } finally { vi.useRealTimers(); }
});

it("leaving the panel stops the polling", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue({ opened: true });
    const refresh = vi.fn(async () => {});
    const { unmount } = render(<AccountPanel account={{ ...signedIn(active), refresh }} />);
    await openPortal();
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("a revoked account says so, and an expired pilot keeps the pilot sentence", () => {
  render(<AccountPanel account={signedIn({ access: "revoked" })} />);
  expect(screen.getByText("Your access was revoked. Contact Mixing Pal.")).toBeTruthy();
  expect(screen.queryByText(/pilot/)).toBeNull();
  cleanup();
  render(<AccountPanel account={signedIn({ access: "expired" })} />);
  expect(screen.getByText("Your pilot access has ended. Contact Mixing Pal to continue.")).toBeTruthy();
});

it("a member whose subscription still exists but is unpaid is sent to fix the card, not offered a new plan", async () => {
  vi.mocked(invoke).mockResolvedValue({ opened: true });
  for (const status of ["past_due", "unpaid"]) {
    render(<AccountPanel account={signedIn({ access: "plan_required", subscription_status: status, plan: "starter", manage: true, trial_available: false })} />);
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Your payment didn't go through.");
    cleanup();
  }
  render(<AccountPanel account={signedIn({ access: "plan_required", subscription_status: "past_due", plan: "starter", manage: true, trial_available: false })} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("account_billing", { action: "portal" }));
  cleanup();
  // A subscription that has ended gets the plans again.
  render(<AccountPanel account={signedIn({ access: "plan_required", subscription_status: "canceled", plan: "starter", manage: true, trial_available: false })} />);
  expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(1);
});

it.each([
  ["Sign out", []],
  ["Delete account…", ["Delete my account"]],
] as const)("after %s, the account is read again so the sign-in copy follows sign-up", async (first, then) => {
  let status: AccountView = { access: "active", capture: false, email: "producer@example.com", remaining_micro_usd: 5_000_000 };
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "account_status") return status;
    status = { access: "signed_out", capture: false, signup: "open" };
    return undefined;
  });
  function Harness() { return <AccountPanel account={useAccount()} />; }
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: first }));
  for (const name of then) fireEvent.click(screen.getByRole("button", { name }));
  expect(await screen.findByText("Sign in with your email.")).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "account_status")).toHaveLength(2);
});

it("a revoked account says so first, before the sharing choice", () => {
  render(<AccountPanel account={signedIn({ access: "revoked" })} />);
  const revoked = screen.getByText("Your access was revoked. Contact Mixing Pal.");
  expect(document.querySelector(".account__title")?.nextElementSibling?.contains(revoked)).toBe(true);
  expect(revoked.compareDocumentPosition(screen.getByRole("checkbox")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
