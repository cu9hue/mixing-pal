#!/usr/bin/env node
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const help = `Mixing Pal pilot operator

Set MIXINGPAL_API_ORIGIN and MIXINGPAL_ADMIN_TOKEN in your shell's secret store.
The token is never an argument. Only localhost may use HTTP.

  npm run admin -- invite email                 Email a seven-day invitation and download link
  npm run admin -- report report-id            Inspect a private report (no local cache)
  npm run admin -- report-notifications         List pending/failed support emails
  npm run admin -- usage                        Balances and held requests
  npm run admin -- revoke member-id              End access and revoke sessions
  npm run admin -- delete-account member-id      Delete identity and shared content
  npm run admin -- delete-turn member-id turn-id Delete a shared turn
  npm run admin -- resolve request-id micro-usd reason
                                                Resolve UNKNOWN cost after checking the provider
  npm run admin -- pause | resume               Stop or resume admissions
  npm run admin -- sweep                        Run reconciliation and deletion now
  npm run admin -- replay-deletions             Replay deletions and revocations after a D1 restore
  npm run admin -- recover-member member-id micro-usd reason
                                                Restore verified total account spending
  npm run admin -- recover-budget micro-usd reason
                                                Restore verified total service spending
  npm run admin -- export member-id turn-id file Save a review reference (no transcript)
  npm run admin -- review file                  Fetch the current export for review

Reports expire after 30 days. Do not save their contents to retained files.
App deletion does not recall emails already sent to the support mailbox.
Monitor report_notification_attention and report_notification_failed logs.

Review references expire with the turn. review checks deletion on each read;
it never caches project content locally. Do not redirect its output to a
retained file. Reviewed examples need a separate retention decision before
being kept as fixtures; trace consent never grants training permission.

Run usage and sweep before each pilot review. Worker error logs contain only
event categories and IDs: held_usage, reconciliation_failed, deletion_failed,
capture_cleanup_backlog, capture_failed, request_failed. Alert on any of these
in Cloudflare Logs.
For held requests without a generation ID, check the provider billing record
before resolve. Do not release a reservation just because time passed.

Deletion sweeps run every ten minutes; capture expires at 30 days and settled
operational records at 90 days. D1 Time Travel backups can retain earlier data
for 7 days on Workers Free or 30 days on Paid. This service requires Paid.
Each stage rejects new capture objects at 4 GB. R2 lifecycle rules independently
expire capture objects after 30 days and deletion journals after 90 days.
Before a restore, deploy with inference disabled and preserve available ledger
records. After restoring D1, apply current migrations, run replay-deletions,
then sweep. Replay blocks ordinary resume until spending is recovered too.
Deletion and revocation metadata is journaled separately in private R2 for 90 days.
Replay turns sharing off for every restored account and invalidates its old
consent version. Producers must opt in again. Recorded revocations also remove
restored sessions; recovering spending never restores revoked access.
Replay also invalidates unused invitations: they may belong to accounts lost
by the restore. Reissue them only after checking the producer's spending.

Settle surviving held requests using provider billing evidence. Recover every
account's TOTAL spent amount (not an adjustment), including charges lost by
the restore, with recover-member. usage lists unrecovered accounts first;
repeat until none remain. Then recover-budget with the verified service total,
including spending by accounts absent from the snapshot. Amounts cannot go
down, and the service total must cover all recorded account spending. Keep the
service paused if lost charges cannot be attributed reliably. Recovery records
each amount and reason atomically; it never grants allowance or renews access.
Only after recovery, check access and costs, resume and enable inference.
Never restore deleted content from an operator's local copy.
`;

export async function operator(action, { origin, token, fetch: send = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Operator access requires HTTPS.");
  }
  if (url.username || url.password || !token) throw new Error("Set the operator origin and token.");
  const response = await send(new URL("/operator", url), { method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(action), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const message = action.action === "invite" && response.status === 502
      ? "Invitation email could not be confirmed. Run the invite command again to send a new code."
      : `Operator request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    await response.body?.cancel();
    throw error;
  }
  return response.json();
}

export async function run(args, connection, print = console.log) {
  const [command, ...values] = args;
  if (!command || command === "help" || command === "--help") { print(help); return; }
  if (command === "replay-deletions") {
    let cursor;
    do { cursor = (await operator({ action: "replay_deletions", ...(cursor ? { cursor } : {}) }, connection)).cursor; } while (cursor);
    print("Deletion journal replayed. Run sweep and recover account and global spending before resuming access.");
    return;
  }
  if (command === "review") {
    if (values.length !== 1) throw new Error("review needs one reference file.");
    const file = resolve(values[0]);
    const reference = JSON.parse(await readFile(file, "utf8"));
    if (reference.origin !== new URL(connection.origin).origin) throw new Error("This reference belongs to another service.");
    if (reference.expires_at <= Date.now()) { await rm(file); throw new Error("This review reference expired and was removed."); }
    try { print(JSON.stringify(await operator({ action: "export", member_id: reference.member_id, turn_id: reference.turn_id }, connection), null, 2)); }
    catch (error) { if (error.status === 404 || error.status === 410) await rm(file); throw error; }
    return;
  }
  const arity = { report: 1, "report-notifications": 0, invite: 1, usage: 0, revoke: 1, "delete-account": 1, "delete-turn": 2, resolve: 3,
    "recover-member": 3, "recover-budget": 2, pause: 0, resume: 0, sweep: 0, export: 3 };
  if (!(command in arity) || values.length !== arity[command]) throw new Error("Unknown command or arguments. Run npm run admin -- help.");
  const payload = command === "report" ? { action: "report", report_id: values[0] }
    : command === "invite" ? { action: "invite", email: values[0] }
    : command === "pause" || command === "resume" ? { action: "pause", paused: command === "pause" }
    : command === "resolve" ? { action: "resolve", request_id: values[0], cost_micro_usd: Number(values[1]), reason: values[2] }
    : command === "recover-member" ? { action: "recover", member_id: values[0], spent_micro_usd: Number(values[1]), reason: values[2] }
    : command === "recover-budget" ? { action: "recover", spent_micro_usd: Number(values[0]), reason: values[1] }
    : { action: command.replaceAll("-", "_"), ...(values[0] ? { member_id: values[0] } : {}), ...(values[1] ? { turn_id: values[1] } : {}) };
  const result = await operator(payload, connection);
  if (command !== "export") { print(JSON.stringify(result, null, 2)); return; }
  const file = resolve(values[2]);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ format: "mixing-pal-review-reference-v1", origin: new URL(connection.origin).origin,
    member_id: values[0], turn_id: values[1], expires_at: result.expires_at }, null, 2), { mode: 0o600, flag: "wx" });
  print(JSON.stringify({ reference: file, complete: result.complete, expires_at: result.expires_at, training_allowed: false }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), { origin: process.env.MIXINGPAL_API_ORIGIN, token: process.env.MIXINGPAL_ADMIN_TOKEN })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
