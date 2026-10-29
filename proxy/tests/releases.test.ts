import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import worker from "../src/index";

const release = {
  version: "0.3.0", notes: "Test release", pub_date: "2026-09-18T12:00:00Z", wire_version: 12,
  commit: "a".repeat(40),
  installer: { key: "releases/0.3.0/Mixing-Pal.dmg", sha256: "a".repeat(64), bytes: 123 },
  updater: { key: "releases/0.3.0/Mixing-Pal.app.tar.gz", sha256: "b".repeat(64), bytes: 456, signature: "signed" },
};

function get(path: string) {
  return worker.fetch(new Request(`https://example.com${path}`), env, createExecutionContext());
}

beforeEach(async () => {
  for (const object of (await env.RELEASES.list()).objects) await env.RELEASES.delete(object.key);
  env.DOWNLOADS_ORIGIN = "https://downloads-staging.mixingpal.com";
});

test("empty and paused channels make no update offer without authentication or database writes", async () => {
  for (const manifest of [{ paused: true, release: null }, { paused: false, release: null }, { paused: true, release }]) {
    await env.RELEASES.put("channels/stable.json", JSON.stringify(manifest));
    const response = await get("/v1/updates/stable");
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await env.DB.prepare('SELECT * FROM "user"').all()).results).toHaveLength(0);
  expect((await env.DB.prepare('SELECT * FROM "requests"').all()).results).toHaveLength(0);
});

test("selected channel offers identical universal updater entries and redirects its installer", async () => {
  await env.RELEASES.put("channels/pilot.json", JSON.stringify({ paused: false, release }));
  const response = await get("/v1/updates/pilot");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json() as any;
  expect(data).toMatchObject({ version: "0.3.0", notes: "Test release", pub_date: release.pub_date });
  expect(data.platforms["darwin-aarch64"]).toEqual(data.platforms["darwin-x86_64"]);
  expect(data.platforms["darwin-aarch64"]).toEqual({ url: "https://downloads-staging.mixingpal.com/releases/0.3.0/Mixing-Pal.app.tar.gz", signature: "signed" });
  const download = await get("/v1/downloads/pilot/macos");
  expect(download.status).toBe(302);
  expect(download.headers.get("location")).toBe("https://downloads-staging.mixingpal.com/releases/0.3.0/Mixing-Pal.dmg");
  expect(download.headers.get("cache-control")).toBe("no-store");
});

test("unavailable downloads and invalid channels do not offer a release", async () => {
  await env.RELEASES.put("channels/stable.json", JSON.stringify({ paused: true, release }));
  expect((await get("/v1/downloads/stable/macos")).status).toBe(503);
  expect((await get("/v1/updates/beta")).status).toBe(404);
});

// A visitor clicks Download on the website; a JSON error would be a dead end.
test("an unavailable download shows a page a person can read, with a way back to the site", async () => {
  await env.RELEASES.put("channels/stable.json", JSON.stringify({ paused: true, release }));
  const download = await get("/v1/downloads/stable/macos");
  expect(download.status).toBe(503);
  expect(download.headers.get("content-type")).toContain("text/html");
  const page = await download.text();
  expect(page).toContain("This download isn't available right now.");
  expect(page).toContain("Try again in a few minutes, or email hello@mixingpal.com.");
  expect(page).toContain('href="https://mixingpal.com/"');
  await env.RELEASES.put("channels/stable.json", " ".repeat(32769));
  expect((await get("/v1/downloads/stable/macos")).headers.get("content-type")).toContain("text/html");
  expect((await get("/v1/updates/stable")).headers.get("content-type")).toContain("application/json");
});

test("bad artifact paths and oversized manifests fail closed", async () => {
  await env.RELEASES.put("channels/stable.json", JSON.stringify({ paused: false, release: { ...release, installer: { ...release.installer, key: "https://evil.test/file.dmg" } } }));
  expect((await get("/v1/downloads/stable/macos")).status).toBe(503);
  await env.RELEASES.put("channels/stable.json", " ".repeat(32769));
  expect((await get("/v1/updates/stable")).status).toBe(503);
});

test("missing storage binding and read failures fail closed", async () => {
  const original = env.RELEASES;
  try {
    env.RELEASES = undefined!;
    expect((await get("/v1/updates/stable")).status).toBe(503);
    env.RELEASES = { get: async () => { throw new Error("storage unavailable"); } } as R2Bucket;
    expect((await get("/v1/updates/stable")).status).toBe(503);
  } finally { env.RELEASES = original; }
});

test("release read failures log only a safe category and channel", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const original = env.RELEASES;
  try {
    await env.RELEASES.put("channels/pilot.json", '{"private":"sensitive manifest text"');
    expect((await get("/v1/updates/pilot")).status).toBe(503);
    env.RELEASES = { get: async () => { throw new Error("secret storage detail"); } } as R2Bucket;
    expect((await get("/v1/updates/pilot")).status).toBe(503);
    expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual([
      { event: "release_read_failed", category: "invalid_manifest", channel: "pilot" },
      { event: "release_read_failed", category: "storage", channel: "pilot" },
    ]);
  } finally { env.RELEASES = original; log.mockRestore(); }
});
