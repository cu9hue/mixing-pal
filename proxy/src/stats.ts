import { DAY, Env } from "./env";

const WEEK = 7 * DAY;

interface Turn { member_id: string; created_at: number; updated_at: number; status: string; incomplete: number }
interface Call { provider: string | null; duration_ms: number | null; usage: string | null; error_code: string | null }

/** Nearest-rank percentile; null for no values. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function count<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

/**
 * The pilot over the last `days`: who comes back, how long answers take,
 * what fails, and which hosts served it. Reads only the ledger's turns and
 * requests, never captured content.
 */
export async function pilotStats(env: Env, days: number, now = Date.now()) {
  const since = now - days * DAY;
  // Retention counts whole weeks, so its first week can start before `since`.
  const firstWeek = now - Math.ceil(days / 7) * WEEK;
  const [turnRows, callRows] = await Promise.all([
    env.DB.prepare(`SELECT member_id, created_at, updated_at, status, incomplete FROM turns
      WHERE created_at >= ? AND deleted_at IS NULL ORDER BY created_at`).bind(firstWeek).all<Turn>(),
    env.DB.prepare(`SELECT r.provider, r.duration_ms, r.usage, r.error_code FROM requests r JOIN turns t ON t.id = r.turn_id
      WHERE r.created_at >= ? AND t.deleted_at IS NULL`).bind(since).all<Call>(),
  ]);
  const turns = turnRows.results.filter((t) => t.created_at >= since);
  const calls = callRows.results;

  const weeks = [];
  let previous = new Set<string>();
  for (let starts = firstWeek; starts < now; starts += WEEK) {
    const inWeek = turnRows.results.filter((t) => t.created_at >= starts && t.created_at < starts + WEEK);
    const members = new Set(inWeek.map((t) => t.member_id));
    weeks.push({ starts, members: members.size, returning: [...members].filter((m) => previous.has(m)).length, turns: inWeek.length });
    previous = members;
  }

  const complete = turns.filter((t) => t.status === "complete").map((t) => (t.updated_at - t.created_at) / 1000);
  const perDay = count(turns, (t) => `${t.member_id} ${Math.floor(t.created_at / DAY)}`);

  const hosts = [...count(calls.filter((c) => c.provider), (c) => c.provider!)].map(([host, n]) => {
    const served = calls.filter((c) => c.provider === host && c.duration_ms);
    const speeds = served.map((c) => {
      const tokens = Number((JSON.parse(c.usage ?? "{}") as { completion_tokens?: number }).completion_tokens ?? 0);
      return tokens / (c.duration_ms! / 1000);
    });
    return { host, calls: n, seconds_median: percentile(served.map((c) => c.duration_ms! / 1000), 50),
      tokens_per_second_median: percentile(speeds, 50) };
  }).sort((x, y) => y.calls - x.calls);

  const members = [...count(turns, (t) => t.member_id)].map(([id, n]) => {
    const own = turns.filter((t) => t.member_id === id);
    return { id, turns: n, active_days: new Set(own.map((t) => Math.floor(t.created_at / DAY))).size,
      last_seen: Math.max(...own.map((t) => t.created_at)) };
  }).sort((x, y) => y.last_seen - x.last_seen);

  return {
    days, since, weeks,
    turns: {
      total: turns.length,
      by_status: Object.fromEntries(count(turns, (t) => t.status)),
      incomplete: turns.filter((t) => t.incomplete).length,
      complete_seconds_p50: percentile(complete, 50),
      complete_seconds_p95: percentile(complete, 95),
      per_member_per_active_day_median: percentile([...perDay.values()], 50),
    },
    errors: [...count(calls.filter((c) => c.error_code), (c) => c.error_code!)]
      .map(([code, n]) => ({ code, count: n })).sort((x, y) => y.count - x.count).slice(0, 10),
    hosts,
    members,
  };
}
