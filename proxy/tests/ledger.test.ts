import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { enrich, expiredStatement, recordConflict, settle, settleExpired, settleProvisional } from "../src/ledger";

const R = 310144;
const now = 1_000_000;

// The retention trigger refuses to delete unresolved rows, so reset drops it and puts it back.
async function reset() {
  const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'request_retention'").first<{ sql: string }>();
  await env.DB.batch([
    ...(trigger ? [env.DB.prepare("DROP TRIGGER request_retention")] : []),
    ...["cost_conflicts", "requests", "turns", "members"].map((t) => env.DB.prepare(`DELETE FROM "${t}"`)),
    env.DB.prepare("UPDATE budget SET spent = 0, reserved = 0, loss = 0, paused = 0, recovery_required = 0, allowance = 50000000"),
    ...(trigger ? [env.DB.prepare(trigger.sql)] : []),
  ]);
}
async function member(id: string, allowance = 5_000_000) {
  await env.DB.prepare("INSERT INTO members(id, period_end, allowance, created_at) VALUES (?, ?, ?, 0)").bind(id, 9e15, allowance).run();
}
async function turn(id: string, memberId: string) {
  await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
    VALUES (?, ?, 0, 0, '0', 14, 0, 0)`).bind(id, memberId).run();
}
async function req(id: string, turnId: string, memberId: string, round = 1, at = now, leased = true) {
  await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
    reserved, status, created_at, updated_at, model${leased ? ", deadline, lease_until" : ""})
    VALUES (?, ?, ?, ?, 'b', 'p', 't', 'v', ?, 'reserved', ?, ?, 'm'${leased ? ", ?, ?" : ""})`)
    .bind(id, turnId, memberId, round, R, at, at, ...(leased ? [at + 270_000, at + 285_000] : [])).run();
}
// A request row as a Worker from before migration 0007 writes it.
async function legacyReq(id: string, turnId: string, memberId: string, updatedAt = 0) {
  await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
    reserved, status, created_at, updated_at, model) VALUES (?, ?, ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, ?, 'm')`)
    .bind(id, turnId, memberId, R, updatedAt).run();
}
const provisional = (id: string) => env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = 1, cost = reserved
  WHERE id = ? AND status != 'settled'`).bind(id).run();
const final = (id: string, cost: number) => env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = 0, cost = ?
  WHERE id = ? AND (status != 'settled' OR provisional = 1)`).bind(cost, id).run();
const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();
const balance = async (id: string) => env.DB.prepare("SELECT spent, reserved FROM members WHERE id = ?").bind(id).first();
const budget = async () => env.DB.prepare("SELECT spent, reserved, loss, paused FROM budget").first();
async function refused(statement: Promise<unknown>, code: string) {
  await expect(statement).rejects.toThrow(code);
}
async function conflict(requestId: string, recorded: number, reported: number, source = "generation") {
  await run("INSERT INTO cost_conflicts(request_id, source, recorded, reported, created_at) VALUES (?, ?, ?, ?, 1)",
    requestId, source, recorded, reported);
}
async function booked(source: string, reported: number) {
  await conflict("r", 1000, reported, source);
  await run("UPDATE cost_conflicts SET resolved_at = 2, resolution = 'booked' WHERE request_id = 'r' AND source = ?", source);
}

// Builds the rows at schema 0006, then applies every migration over them.
async function atSchema6(seed: () => Promise<void>) {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`).all<{ name: string }>();
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = on"),
    ...results.map((t) => env.DB.prepare(`DROP TABLE "${t.name}"`)),
    env.DB.prepare("DELETE FROM d1_migrations"),
  ]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 6));
  await seed();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
const legacyUnknown = () => atSchema6(async () => {
  await member("m"); await turn("t", "m"); await legacyReq("u", "t", "m");
  await run("UPDATE requests SET status = 'unknown' WHERE id = 'u'");
});
const legacyHistory = () => atSchema6(async () => {
  await member("m"); await turn("t", "m"); await turn("h", "m");
  await legacyReq("o", "h", "m");
  await run("UPDATE requests SET status = 'settled', cost = ? WHERE id = 'o'", R + 1);
  await run("UPDATE budget SET paused = 0");
  await legacyReq("u", "t", "m", 5000);
  await run("UPDATE requests SET status = 'unknown' WHERE id = 'u'");
});

// A provisional call, then a later turn's final call, then the real cost of the first.
async function lateOverrun() {
  await member("m", R); await turn("a", "m"); await req("A", "a", "m"); await provisional("A");
  await run("UPDATE turns SET status = 'superseded' WHERE id = 'a'");
  await turn("b", "m"); await req("B", "b", "m", 1, now + 1000); await final("B", R);
  await final("A", R + 1);
}
async function reservedCall() {
  await member("m"); await turn("t", "m"); await req("r", "t", "m");
}
async function finalCall() {
  await reservedCall(); await final("r", 1000);
}
async function provisionalCall() {
  await finalCall(); await turn("t2", "m"); await req("p", "t2", "m", 1, now + 4000); await provisional("p");
}
const cleanup = (at: number) => settleExpired(env, at);

beforeEach(reset);

describe("settlement triggers", () => {
  test("final known cost charges member and budget", async () => {
    await member("m"); await turn("t", "m"); await req("r", "t", "m"); await final("r", 1000);
    expect(await balance("m")).toEqual({ spent: 1000, reserved: 0 });
    expect(await budget()).toMatchObject({ spent: 1000, reserved: 0 });
    expect((await env.DB.prepare("SELECT member_cost FROM requests").first())!.member_cost).toBe(1000);
  });

  test("provisional charges budget only", async () => {
    await member("m", R); await turn("a", "m"); await req("A", "a", "m"); await provisional("A");
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    expect(await budget()).toMatchObject({ spent: R, reserved: 0 });
  });

  test("N1: late real cost never charges the member again", async () => {
    await member("m", R); await turn("a", "m"); await req("A", "a", "m"); await provisional("A");
    await env.DB.prepare("UPDATE turns SET status = 'superseded' WHERE id = 'a'").run();
    await turn("b", "m"); await req("B", "b", "m", 1, now + 1000); await final("B", R);
    await final("A", R + 1);
    expect(await balance("m")).toEqual({ spent: R, reserved: 0 });
    expect(await budget()).toEqual({ spent: R + R + 1, reserved: 0, loss: 1, paused: 1 });
  });

  test("N1: late overrun is a service loss and pauses", async () => {
    await lateOverrun();
    expect(await budget()).toEqual({ spent: R + R + 1, reserved: 0, loss: 1, paused: 1 });
  });

  test("N2: caller cannot supply member_cost", async () => {
    await reservedCall();
    await refused(run("UPDATE requests SET status = 'settled', cost = ?, member_cost = ? WHERE id = 'r'", R + 1, R + 1), "member_cost_derived");
  });

  test("N2: provisional estimate must equal reservation", async () => {
    await reservedCall();
    await refused(run("UPDATE requests SET status = 'settled', provisional = 1, cost = 0 WHERE id = 'r'"), "invalid_provisional");
  });

  test("N2: final row cannot reopen", async () => {
    await finalCall();
    await refused(run("UPDATE requests SET provisional = 1, cost = reserved WHERE id = 'r'"), "final_is_immutable");
  });

  test("N2: final cost cannot change", async () => {
    await finalCall();
    await refused(run("UPDATE requests SET cost = 2000 WHERE id = 'r'"), "final_is_immutable");
  });

  test("N2: settled cannot leave settled", async () => {
    await finalCall();
    await refused(run("UPDATE requests SET status = 'reserved' WHERE id = 'r'"), "settled_is_terminal");
  });

  test("N2: provisional estimate cannot change", async () => {
    await provisionalCall();
    await refused(run("UPDATE requests SET cost = 0 WHERE id = 'p'"), "invalid_provisional");
  });

  test("N2: reservation is frozen", async () => {
    await provisionalCall();
    await refused(run("UPDATE requests SET reserved = 1 WHERE id = 'p'"), "immutable_request");
  });

  test("N2: second finalisation is a no-op (guarded update)", async () => {
    await provisionalCall();
    const before = (await budget())!;
    await final("p", 500); await final("p", 900);
    expect((await budget())!.spent).toBe((before.spent as number) - R + 500);
  });
});

describe("migration", () => {
  test("migration: legacy unknown becomes provisional without charging member", async () => {
    await legacyUnknown();
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    expect(await budget()).toMatchObject({ spent: R, reserved: 0 });
    expect(await env.DB.prepare("SELECT provisional, member_cost FROM requests").first()).toEqual({ provisional: 1, member_cost: 0 });
  });

  test("migration: backfill runs again safely", async () => {
    await legacyUnknown();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0007"))!;
    const from = migration.queries.findIndex((q) => q.includes("UPDATE requests SET deadline"));
    const backfill = migration.queries.slice(from);
    expect(backfill).toHaveLength(3);
    await env.DB.batch(backfill.map((q) => env.DB.prepare(q)));
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    expect(await budget()).toMatchObject({ spent: R, reserved: 0 });
  });
});

describe("admission", () => {
  test("rollback: an old Worker insert without a lease is refused", async () => {
    await member("m"); await turn("t", "m");
    await refused(req("old", "t", "m", 1, now, false), "lease_required");
  });

  test("rollback: a paused service refuses an old Worker insert as paused", async () => {
    await member("m"); await turn("t", "m"); await run("UPDATE budget SET paused = 1");
    await refused(req("old", "t", "m", 1, now, false), "service_paused");
  });

  test("capacity: five live calls refuse a sixth", async () => {
    for (let i = 0; i < 5; i++) { await member(`m${i}`); await turn(`t${i}`, `m${i}`); await req(`r${i}`, `t${i}`, `m${i}`); }
    await member("x"); await turn("tx", "x");
    await refused(req("rx", "tx", "x", 1, now + 1000), "busy");
  });

  test("capacity: expired leases stop counting", async () => {
    for (let i = 0; i < 5; i++) { await member(`m${i}`); await turn(`t${i}`, `m${i}`); await req(`r${i}`, `t${i}`, `m${i}`); }
    await member("x"); await turn("tx", "x");
    await req("rx", "tx", "x", 1, now + 290_001);
    expect(await env.DB.prepare("SELECT status FROM requests WHERE id = 'rx'").first()).toEqual({ status: "reserved" });
  });

  test("N7: global shortfall is budget_exhausted", async () => {
    await run("UPDATE budget SET allowance = ?", R);
    await member("m"); await member("n"); await turn("t", "m"); await turn("u", "n");
    await req("r", "t", "m"); await final("r", R);
    await refused(req("s", "u", "n", 1, now + 1000), "budget_exhausted");
  });

  test("round order: a live earlier round refuses the next", async () => {
    await member("m"); await turn("t", "m"); await req("r1", "t", "m");
    await refused(req("r2", "t", "m", 2, now + 1000), "invalid_round");
  });

  test("round order: after the earlier round settles, the next is admitted", async () => {
    await member("m"); await turn("t", "m"); await req("r1", "t", "m");
    await provisional("r1"); await req("r2", "t", "m", 2, now + 1000);
    expect(await env.DB.prepare("SELECT status FROM requests WHERE id = 'r2'").first()).toEqual({ status: "reserved" });
  });
});

describe("pre-0007 Worker after the migration", () => {
  test("V3-1: account cleanup converts a late legacy unknown row", async () => {
    await member("m", R); await turn("t", "m"); await req("r", "t", "m");
    await run("UPDATE requests SET status = 'unknown' WHERE id = 'r'");
    await cleanup(now + 1000);
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    expect(await budget()).toMatchObject({ spent: R, reserved: 0 });
  });

  test("V3-1: and the member can ask again", async () => {
    await member("m", R); await turn("t", "m"); await req("r", "t", "m");
    await run("UPDATE requests SET status = 'unknown' WHERE id = 'r'");
    await cleanup(now + 1000);
    await run("UPDATE turns SET status = 'superseded' WHERE id = 't'");
    await turn("t2", "m"); await req("r2", "t2", "m", 1, now + 2000);
    expect(await env.DB.prepare("SELECT status FROM requests WHERE id = 'r2'").first()).toEqual({ status: "reserved" });
  });

  test("V3-1: an old settle() of an unknown row never charges the member", async () => {
    await reservedCall();
    await run("UPDATE requests SET status = 'unknown' WHERE id = 'r'");
    await run("UPDATE requests SET status = 'settled', cost = 1000 WHERE id = 'r' AND status != 'settled'");
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    expect(await budget()).toMatchObject({ spent: 1000, reserved: 0 });
    expect((await env.DB.prepare("SELECT member_cost FROM requests").first())!.member_cost).toBe(0);
  });
});

describe("cost conflicts", () => {
  test("V3-2: a higher conflict pauses", async () => {
    await finalCall(); await conflict("r", 1000, R + 1);
    expect((await budget())!.paused).toBe(1);
  });

  test("V3-2: resume is refused while it is open", async () => {
    await finalCall(); await conflict("r", 1000, R + 1);
    await refused(run("UPDATE budget SET paused = 0"), "cost_conflict_open");
  });

  test("V3-2: booking adds the outstanding liability and the overrun loss once", async () => {
    await finalCall(); await conflict("r", 1000, R + 1);
    await run("UPDATE cost_conflicts SET resolved_at = 2, resolution = 'booked' WHERE request_id = 'r'");
    expect(await budget()).toMatchObject({ spent: R + 1, reserved: 0, loss: 1 });
    expect(await balance("m")).toEqual({ spent: 1000, reserved: 0 });
  });

  test("V3-2: two bookings of one liability count it and its loss once", async () => {
    await finalCall(); await booked("operator", 320_000); await booked("generation", 320_000);
    expect(await budget()).toMatchObject({ spent: 320_000, reserved: 0, loss: 320_000 - R });
  });

  test("V3-2: a higher booking adds only the part above the earlier one", async () => {
    await finalCall(); await booked("operator", 1500); await booked("generation", 1600);
    expect(await budget()).toMatchObject({ spent: 1600, reserved: 0, loss: 0 });
  });

  test("V3-2: resume works after resolution", async () => {
    await finalCall(); await conflict("r", 1000, R + 1);
    await run("UPDATE cost_conflicts SET resolved_at = 2, resolution = 'booked' WHERE request_id = 'r'");
    await run("UPDATE budget SET paused = 0");
    expect((await budget())!.paused).toBe(0);
  });

  test("V3-2: a resolved conflict cannot be re-resolved", async () => {
    await finalCall(); await conflict("r", 1000, R + 1);
    await run("UPDATE cost_conflicts SET resolved_at = 2, resolution = 'booked' WHERE request_id = 'r'");
    await refused(run("UPDATE cost_conflicts SET resolution = 'dismissed' WHERE request_id = 'r'"), "conflict_immutable");
  });
});

describe("retention", () => {
  test("V3-3: old pruning cannot delete a provisional row, even paused", async () => {
    await reservedCall(); await provisional("r"); await run("UPDATE budget SET paused = 1");
    await refused(run("DELETE FROM requests WHERE turn_id = 't'"), "unresolved_accounting");
  });

  test("V3-6: an open conflict blocks pruning", async () => {
    await finalCall(); await conflict("r", 1000, 500);
    await refused(run("DELETE FROM requests WHERE turn_id = 't'"), "unresolved_accounting");
  });

  test("V3-6: resolved conflicts deleted first, then pruning succeeds", async () => {
    await finalCall(); await conflict("r", 1000, 500);
    await run("UPDATE cost_conflicts SET resolved_at = 2, resolution = 'dismissed'");
    await run("DELETE FROM cost_conflicts WHERE request_id IN (SELECT id FROM requests WHERE turn_id = 't') AND resolved_at IS NOT NULL");
    await run("DELETE FROM requests WHERE turn_id = 't'"); await run("DELETE FROM turns WHERE id = 't'");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM requests").first())!.n).toBe(0);
  });
});

describe("migration clocks and history", () => {
  test("V3-4: a migrated unknown row gets clocks and a reconcile time", async () => {
    await legacyHistory();
    const u = (await env.DB.prepare("SELECT lease_until, reconcile_after FROM requests WHERE id = 'u'").first<{ lease_until: number; reconcile_after: number }>())!;
    expect(u.lease_until).toBe(5000 + 290_000);
    expect(u.reconcile_after).toBeGreaterThanOrEqual(u.lease_until);
  });

  test("V3-5: history keeps the charged amount", async () => {
    await legacyHistory();
    expect((await env.DB.prepare("SELECT member_cost FROM requests WHERE id = 'o'").first())!.member_cost).toBe(R + 1);
  });
});

describe("member_cost", () => {
  test("N2: a settle statement cannot set member_cost", async () => {
    await reservedCall();
    await refused(run("UPDATE requests SET status = 'settled', cost = 1000, member_cost = 1000 WHERE id = 'r'"), "member_cost_derived");
  });

  test("N2: member_cost never changes after it is set", async () => {
    await finalCall();
    await refused(run("UPDATE requests SET member_cost = 5 WHERE id = 'r'"), "member_cost_derived");
  });
});

describe("legal transitions", () => {
  test("legal: dispatch, id, settle, enrich", async () => {
    await reservedCall();
    await run("UPDATE requests SET status = 'dispatched' WHERE id = 'r' AND status = 'reserved'");
    await run("UPDATE requests SET generation_id = 'gen-1' WHERE id = 'r'"); await final("r", 700);
    await run("UPDATE requests SET provider = 'Inceptron' WHERE id = 'r' AND provider IS NULL");
    expect(await balance("m")).toEqual({ spent: 700, reserved: 0 });
  });

  test("legal: a refused dispatch settles at 0", async () => {
    await reservedCall();
    await run("UPDATE requests SET status = 'dispatched' WHERE id = 'r' AND status = 'reserved'");
    await run("UPDATE requests SET generation_id = 'gen-1' WHERE id = 'r'"); await final("r", 700);
    await turn("t2", "m"); await req("z", "t2", "m", 1, now + 4000); await final("z", 0);
    expect(await balance("m")).toEqual({ spent: 700, reserved: 0 });
  });
});

describe("ledger statements", () => {
  test("settle reports applied, already_final, conflict and not_found", async () => {
    await member("m"); await turn("t", "m"); await req("r", "t", "m");
    expect(await settle(env, "r", 1000, { provider: "Inceptron" })).toBe("applied");
    expect(await settle(env, "r", 1000)).toBe("already_final");
    expect(await settle(env, "r", 1200, {}, "generation")).toBe("conflict");
    expect(await settle(env, "missing", 1)).toBe("not_found");
    expect(await env.DB.prepare("SELECT source, recorded, reported FROM cost_conflicts").first())
      .toEqual({ source: "generation", recorded: 1000, reported: 1200 });
    expect((await budget())!.paused).toBe(1);
    expect((await env.DB.prepare("SELECT provider FROM requests").first())!.provider).toBe("Inceptron");
  });

  test("an overrun settled on an open row charges the member the reservation and books the rest to loss", async () => {
    await member("m"); await turn("t", "m"); await req("r", "t", "m");
    expect(await settle(env, "r", R + 5000)).toBe("applied");
    expect(await balance("m")).toEqual({ spent: R, reserved: 0 });
    expect((await env.DB.prepare("SELECT member_cost FROM requests").first())!.member_cost).toBe(R);
    expect(await budget()).toEqual({ spent: R + 5000, reserved: 0, loss: 5000, paused: 1 });
  });

  test("settle finalizes a provisional row without charging the member", async () => {
    await member("m"); await turn("t", "m"); await req("r", "t", "m");
    expect(await settleProvisional(env, "r", "provider_interrupted", now)).toBe(true);
    expect(await settleProvisional(env, "r", "provider_interrupted", now)).toBe(false);
    expect((await env.DB.prepare("SELECT reconcile_after FROM requests").first())!.reconcile_after).toBe(now + 60_000);
    expect(await settle(env, "r", 700, {}, "generation")).toBe("applied");
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    expect((await budget())!.spent).toBe(700);
  });

  test("enrich fills only empty metadata and never cost", async () => {
    await member("m"); await turn("t", "m"); await req("r", "t", "m");
    await enrich(env, "r", { generationId: "gen-1" });
    await settle(env, "r", 500, { provider: "Inceptron" });
    await enrich(env, "r", { provider: "Other", finishReason: "stop", generationId: "gen-2" });
    expect(await env.DB.prepare("SELECT generation_id, provider, finish_reason, cost FROM requests").first())
      .toEqual({ generation_id: "gen-1", provider: "Inceptron", finish_reason: "stop", cost: 500 });
  });

  test("settleExpired converts expired and legacy unknown rows of every member", async () => {
    await member("m"); await member("n"); await turn("t", "m"); await turn("u", "n");
    await req("r", "t", "m"); await req("s", "u", "n");
    await env.DB.prepare("UPDATE requests SET status = 'unknown' WHERE id = 's'").run();
    expect(await settleExpired(env, now + 1000)).toBe(1);
    expect(await settleExpired(env, now + 285_001)).toBe(1);
    // r was never dispatched, so only the legacy unknown row is provisional.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE provisional = 1").first())!.n).toBe(1);
    expect(expiredStatement(env, now)).toBeTruthy();
  });

  test("an expired reserved row was never sent and settles final at 0; an expired dispatched row stays provisional", async () => {
    await member("m"); await turn("t", "m"); await turn("u", "m");
    await req("r", "t", "m"); await req("d", "u", "m");
    await run("UPDATE requests SET status = 'dispatched' WHERE id = 'd'");
    expect(await settleExpired(env, now + 285_000)).toBe(2);
    const row = (id: string) => env.DB.prepare(`SELECT status, provisional, cost, member_cost, error_code, reconcile_after
      FROM requests WHERE id = ?`).bind(id).first();
    expect(await row("r")).toEqual({ status: "settled", provisional: 0, cost: 0, member_cost: 0,
      error_code: "not_dispatched", reconcile_after: 0 });
    expect(await row("d")).toEqual({ status: "settled", provisional: 1, cost: R, member_cost: 0,
      error_code: "worker_interrupted", reconcile_after: now + 285_000 + 60_000 });
    expect(await balance("m")).toEqual({ spent: 0, reserved: 0 });
    // Only the dispatched call reaches the budget.
    expect(await budget()).toEqual({ spent: R, reserved: 0, loss: 0, paused: 0 });
  });

  test("a lower conflict is recorded and does not pause", async () => {
    await member("m"); await turn("t", "m"); await req("r", "t", "m"); await settle(env, "r", 1000);
    await recordConflict(env, "r", "operator", 1000, 900);
    expect((await budget())!.paused).toBe(0);
  });
});
