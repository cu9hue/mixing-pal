# Distribution Stage 1 — Installable DMG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a universal macOS `.dmg` that installs and runs Mixing Pal on a
Mac that has never seen this repository.

**Architecture:** Almost all of this is configuration. The Rust already expects a
bundled connector — `connector_source` in `src-tauri/src/install.rs:117` reads
`resource_dir()` and only falls back to a compile-time repo path when that fails.
The work is to make the bundle real, guard the two strings that hold it together
with tripwire tests, build for both architectures, and then verify on a clean
macOS user account, which is the only environment where the fallback cannot mask
a broken bundle.

**Tech Stack:** Tauri 2.11, Rust (serde_json), vitest, `rustup`, `lipo`,
`PlistBuddy`.

**Spec:** `docs/superpowers/specs/2026-08-20-distribution.md` (stage 1 only)

## Global Constraints

- **macOS only.** Windows and Linux are explicitly out of scope.
- **`bundle.macOS.minimumSystemVersion` is `"11.0"`** — Live 12's own floor,
  read from `/Applications/Ableton Live 12 Suite.app/Contents/Info.plist`.
- **The bundle is the only source of truth for the connector.** Nothing the app
  installs may come from the machine that built it.
- **No new dependencies.** `serde_json` is already a `src-tauri` dependency;
  the frontend tripwire uses `node:fs` exactly as `src/ui/cardStaysMounted.test.ts`
  does, including the `@ts-expect-error` comments, because this project has no
  `@types/node`.
- **Tripwire idiom:** `include_str!` the config, assert against it, and write a
  failure message that names the failure mode — see
  `src-tauri/src/connector.rs` and `src-tauri/src/window.rs:141`.
- **Do not touch model access.** `src/setup/screens.tsx:155` (`AccountScreen`)
  and the `hasAccount: true` hardcode at `src/App.tsx:112` are subsystem B's.
  Leave both alone.
- **These must stay green:** `npx vitest run`, `npm run build`, and
  `cd src-tauri && cargo test`.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | Modify | Bundle configuration: resources, targets, category, macOS floor |
| `src-tauri/src/connector.rs` | Modify (tests only) | Gains the tripwire tying `bundle.resources` to `folder()` |
| `src/releaseVersions.test.ts` | Create | Tripwire: the three manifests agree on the version |
| `package.json` | Modify | A named script for the universal release build |
| `docs/manual-verification.md` | Modify | The clean-account first-run checklist |
| `docs/opening-an-unsigned-build.md` | Create | Gatekeeper instructions for a downloaded build; deleted by stage 2 |

No new runtime code. Two new tests and four configuration keys.

## Decisions taken while planning

Recorded so a reviewer can reject them on the merits rather than guess at intent.

1. **`bundle.category` is `"Music"`, not `"public.app-category.music"`.** The
   spec wrote the raw UTI. Tauri's config takes an `AppCategory` enum name and
   maps it to the UTI itself; the schema's accepted list contains `Music`.
2. **No `bundle.macOS.dmg` block.** The spec asked for explicit `appPosition`
   and `applicationFolderPosition` "so the drag target is unmissable". Tauri
   already defaults to a 660×400 window with the app at (180,170) and
   Applications at (480,170) — the standard layout. Setting them would restate
   defaults, which is noise.
3. **The version tripwire (Task 3) is pulled forward from stage 3.** The spec
   files version numbering under stage 3, where the updater needs it. It is
   about twenty lines and drift is much easier to prevent than to notice, so it
   lands now. A reviewer who disagrees can move it without affecting any other
   task.

---

### Task 1: Bundle the connector as a resource

**Files:**
- Modify: `src-tauri/tauri.conf.json` (the `bundle` object)
- Test: `src-tauri/src/connector.rs` (add to the existing `mod tests`)

**Interfaces:**
- Consumes: `connector::folder()` — `pub fn folder() -> &'static str`, returns
  `"MixingPal"` from `shared/connector.json`.
- Produces: nothing new in code. Produces the fact that a built `.app` contains
  `Contents/Resources/MixingPal/`, which Task 2 verifies against a real bundle.

- [ ] **Step 1: Write the failing test**

Add this to the existing `mod tests` block at the bottom of
`src-tauri/src/connector.rs`, below `the_folder_is_a_bare_directory_name`:

```rust
    /// The bundle must carry the connector, to the exact directory
    /// `connector_source` looks in.
    ///
    /// `connector_source` joins `folder()` onto `resource_dir()`, which is
    /// `Contents/Resources` inside a macOS `.app`. If `bundle.resources` is
    /// missing, or maps to a different destination, the built app has no
    /// connector and falls through to the `CARGO_MANIFEST_DIR` branch -- a
    /// path baked in at compile time, pointing at the build machine. That
    /// branch succeeds on the build machine and nowhere else, so this
    /// failure is invisible in exactly the place it gets introduced.
    #[test]
    fn the_bundle_ships_the_connector_where_connector_source_looks_for_it() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must be valid JSON");

        let resources = conf
            .get("bundle")
            .and_then(|bundle| bundle.get("resources"))
            .and_then(|resources| resources.as_object())
            .expect(
                "tauri.conf.json needs a bundle.resources map -- without it the connector \
                 is not in the .app at all, and first run fails on every machine but the \
                 one that built it",
            );

        let from = format!("../remote-script/{}/", folder());
        let to = format!("{}/", folder());

        assert_eq!(
            resources.get(&from).and_then(|dest| dest.as_str()),
            Some(to.as_str()),
            "bundle.resources must map {:?} to {:?}, because connector_source() joins \
             connector::folder() onto resource_dir(). Renaming the connector without \
             updating this map ships an app that cannot find its own connector.",
            from,
            to
        );
    }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test the_bundle_ships_the_connector 2>&1 | tail -20
```

Expected: FAIL, panicking on the `.expect(...)` message about needing a
`bundle.resources` map — `tauri.conf.json` has no such key yet.

- [ ] **Step 3: Add the resource mapping**

In `src-tauri/tauri.conf.json`, inside the `bundle` object, add a `resources`
key. The `bundle` object should read:

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "resources": {
      "../remote-script/MixingPal/": "MixingPal/"
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

Both trailing slashes matter. The source slash tells Tauri this is a directory
whose contents are copied; the destination slash names the directory they land
in. `targets` is left alone here — Task 2 changes it.

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd src-tauri && cargo test the_bundle_ships_the_connector 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Prove it against a real bundle**

A passing test proves the config says the right thing. This proves Tauri acts
on it. A debug bundle is enough and takes well under a minute:

```bash
npm run tauri build -- --bundles app --debug 2>&1 | tail -3
APP="src-tauri/target/debug/bundle/macos/Mixing Pal.app"
ls "$APP/Contents/Resources/MixingPal/mixingpal/version.py"
echo "bundled: $(find "$APP/Contents/Resources/MixingPal" -type f | wc -l)  source: $(find remote-script/MixingPal -type f | wc -l)"
find "$APP/Contents/Resources/MixingPal" \( -name "__pycache__" -o -name "*.pyc" \) | head
```

Expected: `version.py` listed; both counts `36`; the `find` for `__pycache__`
prints nothing. Then remove the artifacts so they are not committed:

```bash
rm -rf src-tauri/target/debug/bundle
```

- [ ] **Step 6: Run the full suites**

```bash
cd src-tauri && cargo test 2>&1 | tail -5
```

Expected: all tests pass, one more than before.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/connector.rs
git commit -m "Ship the connector inside the app bundle

connector_source has always looked in resource_dir() first and fallen
back to a CARGO_MANIFEST_DIR path from the build machine. Nothing ever
put anything in resource_dir(), so the fallback always won and first
run failed on every computer but this one.

The tripwire ties the destination to connector::folder(). They have no
type-level relationship, and a build where they disagree does not fail
-- it silently ships an app with no connector, which the fallback then
hides on the machine that built it."
```

---

### Task 2: Build universal, for the macOS versions Live supports

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`bundle.targets`, `bundle.category`, `bundle.macOS`)
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: the `bundle.resources` key from Task 1. Do not remove or reorder it.
- Produces: `npm run build:mac`, which writes
  `src-tauri/target/universal-apple-darwin/release/bundle/dmg/Mixing Pal_<version>_universal.dmg`.

**Note on timing:** the build in Step 5 compiles the whole dependency tree in
release mode for two architectures. Twenty minutes on a cold cache is normal.
It has not hung.

- [ ] **Step 1: Install the second Rust target**

```bash
rustup target add x86_64-apple-darwin
rustup target list --installed
```

Expected: the list now contains both `aarch64-apple-darwin` and
`x86_64-apple-darwin`. Without the second one, the universal build fails at the
link step.

- [ ] **Step 2: Set the bundle targets, category, and macOS floor**

In `src-tauri/tauri.conf.json`, change `bundle.targets` from `"all"` to the
explicit list, and add `category` and a `macOS` object. The `bundle` object
should read:

```json
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "category": "Music",
    "resources": {
      "../remote-script/MixingPal/": "MixingPal/"
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "11.0"
    }
  }
```

Three things worth knowing:

- `"all"` on macOS already means `app` and `dmg`, so this changes nothing today.
  It exists so that stage 3 turning on `createUpdaterArtifacts` produces a
  deliberate list rather than a surprise.
- `"Music"` is a Tauri `AppCategory` enum name. Tauri converts it to the
  `public.app-category.music` UTI in `Info.plist`. Writing the UTI here is
  rejected.
- `"11.0"` is Live 12's own `LSMinimumSystemVersion`. Tauri's default is
  `10.13`. Since this app is useless without Live, matching Live's floor
  excludes nobody.

- [ ] **Step 3: Add a named build script**

In `package.json`, add `build:mac` to `scripts`, after `"tauri"`:

```json
    "tauri": "tauri",
    "build:mac": "tauri build --target universal-apple-darwin",
    "test": "vitest run"
```

- [ ] **Step 4: Check the config still parses and the tripwire holds**

```bash
cd src-tauri && cargo test the_bundle_ships_the_connector 2>&1 | tail -5
```

Expected: PASS. This catches a JSON syntax error or a `resources` key lost while
editing, before spending twenty minutes on a build.

- [ ] **Step 5: Build the universal DMG**

```bash
npm run build:mac 2>&1 | tail -5
```

Expected: finishes with `Finished 2 bundles at:` naming an `.app` and a `.dmg`.

- [ ] **Step 6: Inspect the artifact**

```bash
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Mixing Pal.app"
lipo -archs "$APP/Contents/MacOS/"*
/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print :LSApplicationCategoryType" "$APP/Contents/Info.plist"
ls "$APP/Contents/Resources/MixingPal/mixingpal/version.py"
ls -lh src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

Expected, in order: `x86_64 arm64`; `11.0`; `public.app-category.music`; the
`version.py` path; and one `.dmg` file.

The two `Info.plist` values were confirmed against a real debug bundle while
this plan was written, so they are expectations rather than guesses. The glob
in the `lipo` line is deliberate: the executable is named `mixing-pal`, after
the Cargo package, not `Mixing Pal` after the product.

If `lipo` prints only `arm64`, the `--target universal-apple-darwin` flag did
not take effect.

- [ ] **Step 7: Commit**

Do not commit the build artifacts — they live under `src-tauri/target/`, which
is already git-ignored. Confirm with `git status --porcelain` before adding.

```bash
git add src-tauri/tauri.conf.json package.json
git commit -m "Build one DMG that runs on every Mac Live 12 runs on

Universal, so Intel and Apple Silicon get the same artifact, and floored
at macOS 11.0 because that is Live 12's own LSMinimumSystemVersion --
this app is useless without Live, so matching its floor excludes nobody.

targets becomes an explicit list so that turning on updater artifacts in
stage 3 is a deliberate change rather than a side effect of \"all\"."
```

---

### Task 3: Tripwire the release version across the three manifests

**Files:**
- Create: `src/releaseVersions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `src/releaseVersions.test.ts`. The `@ts-expect-error` comments are
required, not optional: this project has no `@types/node`, and the same pattern
appears in `src/ui/cardStaysMounted.test.ts` and `vite.config.ts:4`.

```ts
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
```

- [ ] **Step 2: Run it**

```bash
npx vitest run src/releaseVersions.test.ts 2>&1 | tail -10
```

Expected: PASS — all three files already say `0.1.0`. This test is written
green on purpose; there is no production code to add, and the behaviour it
guards is a future human error.

- [ ] **Step 3: Prove it can fail**

A tripwire nobody has seen fail is a tripwire nobody knows works. Break one
version, watch it go red, then put it back:

```bash
node -e 'const fs=require("fs");const p="package.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.version="9.9.9";fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")'
npx vitest run src/releaseVersions.test.ts 2>&1 | tail -10
git checkout package.json
npx vitest run src/releaseVersions.test.ts 2>&1 | tail -5
```

Expected: FAIL on the `package.json` case while broken, then PASS again after
`git checkout`. Note that Task 2 also edits `package.json`; run this step only
after Task 2's commit, so `git checkout package.json` cannot discard the
`build:mac` script.

- [ ] **Step 4: Run the full frontend suite**

```bash
npx vitest run 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected: all tests pass, three more than before; `tsc && vite build` clean.

- [ ] **Step 5: Commit**

```bash
git add src/releaseVersions.test.ts
git commit -m "Tripwire the release version across all three manifests

Tauri reads the running app's version from tauri.conf.json, so that is
the file stage 3's updater compares against the hosted manifest. The
other two can drift with nothing failing, which is exactly why they do.
Bumping a release is a human editing three files; this checks all three."
```

---

### Task 4: The clean-account first-run checklist

**Files:**
- Modify: `docs/manual-verification.md` (append a section)

**Interfaces:**
- Consumes: the `.dmg` produced by Task 2's `npm run build:mac`.
- Produces: nothing in code.

This task writes the checklist. **Running it is a human's job** — it needs a
second macOS user account, a real Ableton Live, and a real set. An agent
executing this plan finishes at the commit.

- [ ] **Step 1: Append the section**

Add this to the end of `docs/manual-verification.md`, matching the existing
checkbox style:

```markdown
## Stage 1 distribution — a clean Mac (added 2026-08-20)

This is the test the `.dmg` exists for, and it cannot be run on the build
machine. That machine has the repo, so `connector_source`'s
`CARGO_MANIFEST_DIR` fallback succeeds even when the bundle is empty — the
one failure this whole stage exists to prevent is the one failure the build
machine cannot show you.

A fresh macOS user account is a real clean room and costs nothing. Live sits
in `/Applications` and every account can run it, while
`~/Music/Ableton/User Library` is per-account, so a new account starts with
no connector, no settings, and no repository.

Date: ___________  macOS version: ___________  Tester: ___________

- [ ] Create a new account in System Settings → Users & Groups, log into it,
      and copy the `.dmg` across over USB or the local network — **not**
      AirDrop, and not a browser download. Both of those set
      `com.apple.quarantine`, and macOS blocks a quarantined unsigned app.
      Stage 2 removes that difference; until then, the delivery route is
      part of what is being tested.
- [ ] Open the `.dmg`. It shows the app beside an Applications folder. Drag
      it across.
- [ ] Launch Mixing Pal from `/Applications`. It opens with no warning of
      any kind.
- [ ] Setup opens on the install step. Work through it. Afterwards
      `~/Music/Ableton/User Library/Remote Scripts/MixingPal` exists **in
      this account**. If it does not, the bundle shipped without its
      connector.
- [ ] **Write down whether macOS asked permission for anything**, and what
      it named. Stage 2 depends on the answer: permission grants are keyed
      to an app's code signature, and an unsigned build gets a new signature
      every time it is built, so any grant needed here is a grant that
      every future update would silently lose.
- [ ] Start Live. Add MixingPal under Preferences → Link, Tempo & MIDI →
      Control Surface. Deltas arrive and setup advances to the connected
      step.
- [ ] Open Advanced, set an OpenRouter key and a model, then ask a question
      about the set and get an answer. **Expect to do this by hand.** The
      app installs cleanly and then cannot answer anything until both are
      set, because `run_model` refuses while either is empty and nothing in
      setup asks for them. Closing that gap is subsystem B, not this stage.
- [ ] Quit and relaunch. Setup does **not** reopen.
```

- [ ] **Step 2: Commit**

```bash
git add docs/manual-verification.md
git commit -m "Add the clean-account first-run checklist

The build machine cannot run this test. It has the repo, so
connector_source's CARGO_MANIFEST_DIR fallback succeeds even from an
empty bundle -- it hides precisely the failure stage 1 exists to
prevent. A second user account has no repo and its own User Library,
which makes it a real clean room for nothing.

Also records what to watch for on macOS permission prompts, because
stage 2 needs that answer and this run produces it for free."
```

---

### Task 5: Write the page for anyone who gets the DMG as a download

**Files:**
- Create: `docs/opening-an-unsigned-build.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing in code.

The spec calls for this and no other task covers it. Stage 1's own delivery
route — hand-carried over USB to one person — never trips Gatekeeper, so this
page is not for her. It is for a beta tester who receives the `.dmg` by
download or AirDrop before stage 2 lands, because both of those set
`com.apple.quarantine` and macOS then refuses to open an unsigned app.

Stage 2 deletes this file. It exists to cover the window between the first
shareable artifact and the first signed one.

- [ ] **Step 1: Write the page**

Create `docs/opening-an-unsigned-build.md`:

```markdown
# Opening Mixing Pal before it's signed

If you downloaded this, macOS will refuse to open it the first time and say
Mixing Pal is damaged, or that it cannot check it for malicious software.

It is not damaged. macOS says that about any app it cannot trace to a
registered developer, and Mixing Pal is not registered yet. Here is how to
open it anyway. You do this once.

1. Drag Mixing Pal into your Applications folder.
2. Double-click it. macOS refuses. Dismiss the dialog.
3. Open System Settings → Privacy & Security, and scroll down. There is a
   line saying Mixing Pal was blocked, with an **Open Anyway** button next
   to it. Click it.
4. Confirm with your password or Touch ID.
5. Mixing Pal opens, and every launch after this one is normal.

Step 3 has to come after step 2. The button only appears once macOS has
something to tell you about, and it disappears again after a while — if you
cannot find it, double-click the app again and go straight back.

If you were sent Mixing Pal on a USB stick or over your local network, none
of this happens and the app just opens. The warning comes from downloading,
not from the app.

**Nobody should ever ask you to run a Terminal command to get around this,
including us.** There is one, and it works, and being willing to type it is
exactly what someone distributing real malware is counting on. The button in
System Settings does the same job and tells you what you are agreeing to.
```

- [ ] **Step 2: Note what a human still owes this page**

The page describes a dialog and a settings pane. Screenshots would make it
better, and they cannot be taken until someone actually has a blocked build in
front of them — which happens the first time a tester is sent one, not now.

Add a line to the "Notes for the tester" section of
`docs/manual-verification.md` recording that:

```markdown
- If you hit the Gatekeeper block described in
  `docs/opening-an-unsigned-build.md`, screenshot each step and add the
  images to that page. It was written from the documented behaviour of
  macOS, not from a build anyone had actually been refused.
```

- [ ] **Step 3: Commit**

```bash
git add docs/opening-an-unsigned-build.md docs/manual-verification.md
git commit -m "Explain the Gatekeeper block to whoever downloads a build

Hand-carrying the DMG over USB never trips Gatekeeper, so this is not
for the first user -- it is for a beta tester who gets it by download or
AirDrop, both of which set com.apple.quarantine. Control-click to open
stopped working in Sequoia, so System Settings is now the only route.

The page refuses to give out the xattr command, and says why. Teaching
someone to disable a security control on request is the exact move
malware distribution depends on, and we do not get to be the friendly
exception."
```

---

## After this plan

Stage 1 is done when the checklist above has been run and passed on a clean
account. Stages 2 and 3 — Developer ID signing, notarization, release CI,
hosting, and the in-app updater — are one further plan, and it cannot start
until the Apple Developer enrollment completes and a `Developer ID Application`
certificate exists.
