import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { readFileSync } from "node:fs";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const tauriConf = JSON.parse(
  readFileSync(ROOT + "src-tauri/tauri.conf.json", "utf8"),
) as { version: string };
const pkg = JSON.parse(readFileSync(ROOT + "package.json", "utf8")) as { version: string };

// The [package] version is the only `version = "..."` that starts a line.
// Dependency versions all sit inside inline tables -- `tauri = { version =
// "2", ... }` -- so the anchors keep this from matching one of those.
const cargoVersion = /^version = "([^"]+)"$/m.exec(
  readFileSync(ROOT + "src-tauri/Cargo.toml", "utf8"),
)?.[1];

/**
 * One release, one number.
 *
 * Tauri takes the running app's version from `tauri.conf.json`, and stage 3's
 * updater compares that against the version in the hosted manifest. So
 * `tauri.conf.json` is the one that decides whether an update is offered, and
 * the other two are free to drift without anything failing -- which is the
 * problem. A release whose Cargo package and npm package claim a different
 * number than the app reports is a release nobody can reason about later.
 *
 * Bumping a version is a human action across three files. This is the check
 * that the human did all three.
 */
describe("the release version", () => {
  it("is readable from Cargo.toml", () => {
    expect(cargoVersion).toBeDefined();
  });

  it("is the same in package.json as in tauri.conf.json", () => {
    expect(pkg.version).toBe(tauriConf.version);
  });

  it("is the same in Cargo.toml as in tauri.conf.json", () => {
    expect(cargoVersion).toBe(tauriConf.version);
  });
});
