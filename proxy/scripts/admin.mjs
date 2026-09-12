#!/usr/bin/env node
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const help = `Mixing Pal pilot operator

Set MIXINGPAL_API_ORIGIN and MIXINGPAL_ADMIN_TOKEN in your shell's secret store.
The token is never an argument. Only localhost may use HTTP.

  npm run admin -- invite email                 Issue a seven-day code; send nothing
  npm run admin -- usage                        Balances and held requests
  npm run admin -- revoke member-id              End access and revoke sessions
  npm run admin -- delete-account member-id      Delete identity and shared content
  npm run admin -- delete-turn member-id turn-id Delete a shared turn
  npm run admin -- resolve request-id micro-usd reason
                                                Resolve UNKNOWN cost after checking the provider
  npm run admin -- pause | resume               Stop or resume admissions
  npm run admin -- sweep                        Run reconciliation and deletion now
  npm run admin -- replay-deletions             Reapply the external journal after a D1 restore
  npm run admin -- export member-id turn-id file Save a review reference (no transcript)
  npm run admin -- review file                  Fetch the current export for review

Review references expire with the turn. review checks deletion on each read;
it never caches project content locally. Do not redirect its output to a
retained file. Reviewed examples need a separate retention decision before
being kept as fixtures; trace consent never grants training permission.

Run usage and sweep before each pilot review. Worker error logs contain only
event categories and IDs: held_usage, reconciliation_failed, deletion_failed,
capture_failed, request_failed. Alert on any of these in Cloudflare Logs.
For held requests without a generation ID, check the provider billing record
before resolve. Do not release a reservation just because time passed.

Deletion sweeps run every ten minutes; capture expires at 30 days and settled
operational records at 90 days. D1 Time Travel backups can retain earlier data
for 7 days on Workers Free or 30 days on Paid. This service requires Paid.
Before a restore, deploy with inference disabled. After restoring D1, run
replay-deletions, then sweep. Deletion metadata is journaled separately in
private R2 for 90 days. Check access and held costs before enabling inference.
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
    const error = new Error(`Operator request failed (${response.status}).`);
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
    print("Deletion journal replayed. Admissions remain paused. Run sweep before enabling access.");
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
  const arity = { invite: 1, usage: 0, revoke: 1, "delete-account": 1, "delete-turn": 2, resolve: 3, pause: 0, resume: 0, sweep: 0, export: 3 };
  if (!(command in arity) || values.length !== arity[command]) throw new Error("Unknown command or arguments. Run npm run admin -- help.");
  const payload = command === "invite" ? { action: "invite", email: values[0] }
    : command === "pause" || command === "resume" ? { action: "pause", paused: command === "pause" }
    : command === "resolve" ? { action: "resolve", request_id: values[0], cost_micro_usd: Number(values[1]), reason: values[2] }
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
