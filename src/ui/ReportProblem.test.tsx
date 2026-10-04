// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ReportProblem, ReportHistory } from "./ReportProblem";
import { ReportTarget } from "../model/reports";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
const target: ReportTarget = { origin: "error", exchange: { turnId: "turn", accountId: "owner", question: "Why?", answer: null, error: "Interrupted" } };
const receipt = { id: "report", origin: "error", turn_id: "turn", created_at: 1, status: "queued" };
beforeEach(() => {
  native.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  native.mockImplementation(async (cmd) => cmd === "incident_snapshot" ? { limitations: ["Trace unavailable after restart."] } : receipt);
});
afterEach(cleanup);
function form() { return render(<ReportProblem target={target} accountId="owner" email="producer@example.com" onClose={() => {}} />); }

it("sends only the native input fields even when the controller target carries account metadata", async () => {
  const selected = { ...target, accountId: "owner", email: "producer@example.com" };
  render(<ReportProblem target={selected} accountId="owner" email={selected.email} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "Failure" } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByText(/Waiting to send/);
  const payload = native.mock.calls[0][1] as { input: Record<string, unknown> };
  expect(Object.keys(payload.input).sort()).toEqual(["accountId", "description", "exchange", "id", "includeDiagnostics", "origin"]);
});

it("requires a description and leaves diagnostics off, then shows the queue receipt", async () => {
  form();
  const send = screen.getByRole("button", { name: "Send report" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "   " } });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "Could not ask\na second question" } });
  fireEvent.click(send);
  await screen.findByText(/Waiting to send/);
  const payload = native.mock.calls.find(([cmd]) => cmd === "report_submit")![1] as { input: Record<string, unknown> };
  expect(payload.input.includeDiagnostics).toBe(false);
  expect(payload.input.description).toBe("Could not ask\na second question");
  expect(native.mock.calls.some(([cmd]) => cmd === "incident_snapshot")).toBe(false);
  expect(screen.queryByText("Report sent.")).toBeNull();
});

it("previews limitations only after consent and prevents duplicate sends", async () => {
  let finish!: (value: unknown) => void;
  native.mockImplementation(async (cmd) => cmd === "incident_snapshot" ? { limitations: ["Trace unavailable after restart."] } : new Promise((resolve) => { finish = resolve; }));
  form();
  fireEvent.click(screen.getByLabelText("Include diagnostics for this report"));
  await screen.findByText("Trace unavailable after restart.");
  fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "Failure" } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  fireEvent.click(screen.getByRole("button", { name: "Sending…" }));
  expect(native.mock.calls.filter(([cmd]) => cmd === "report_submit")).toHaveLength(1);
  expect(native).toHaveBeenCalledWith("report_submit", { input: expect.objectContaining({ accountId: "owner", includeDiagnostics: true, exchange: target.exchange }) });
  finish({ ...receipt, status: "received" });
  await screen.findByText("Report sent.");
});

it("keeps text and the same report ID after an uncertain submit error", async () => {
  form();
  native.mockRejectedValueOnce({ message: "Storage unavailable" });
  fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "Failure" } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("What went wrong?") as HTMLTextAreaElement).value).toBe("Failure");
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByText(/Waiting to send/);
  expect(native.mock.calls[0][1]).toEqual(native.mock.calls[1][1]);
});

it("restores focus on close and does not submit textarea Enter", () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const view = form();
  const textarea = screen.getByLabelText("What went wrong?");
  expect(document.activeElement).toBe(textarea);
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(native).not.toHaveBeenCalled();
  view.unmount(); expect(document.activeElement).toBe(trigger); trigger.remove();
});

it("loads receipts on demand and confirms cancellation without promising email recall", async () => {
  native.mockImplementation(async (cmd) => cmd === "report_list" ? [receipt] : undefined);
  render(<ReportHistory />);
  expect(native).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Recent reports" }));
  await screen.findByText(/Waiting to send/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel report" }));
  expect(screen.getByText(/Emails already sent cannot be recalled/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await waitFor(() => expect(native).toHaveBeenCalledWith("report_delete", { id: "report" }));
});
