import { invoke } from "@tauri-apps/api/core";
import { Exchange } from "../ui/thread";

export type ReportOrigin = "answer" | "error" | "settings";
export interface ReportTarget { origin: ReportOrigin; exchange?: Exchange }
export interface ReportReceipt {
  id: string;
  origin: ReportOrigin;
  turn_id: string | null;
  created_at: number;
  status: "queued" | "received" | "needs_sign_in" | "failed" | "deleting" | "deleted" | "expired";
}

export const reportStatus: Record<ReportReceipt["status"], string> = {
  queued: "Waiting to send. We’ll retry while Mixing Pal is open.",
  received: "Report sent.",
  needs_sign_in: "Sign in again to send this report.",
  failed: "Could not send this report. Cancel it and submit a new report.",
  deleting: "Waiting to confirm deletion. We’ll retry while Mixing Pal is open.",
  deleted: "Stored report deleted. Emails already sent cannot be recalled.",
  expired: "Unable to confirm delivery. The local report expired.",
};

export function sendReport(input: ReportTarget & { id: string; accountId: string; description: string; includeDiagnostics: boolean }) {
  return invoke<ReportReceipt>("report_submit", { input });
}
export const listReports = () => invoke<ReportReceipt[]>("report_list");
export const deleteReport = (id: string) => invoke<void>("report_delete", { id });
export const previewReport = (exchange?: Exchange) => invoke<{ limitations: string[] }>("incident_snapshot", { exchange });
