# Product UI: First Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take someone from double-clicking the app to asking their first question, with no terminal, no bash script, and no guessing at Live's preferences.

**Architecture:** A setup window that shrinks into the card. Which step she is on is **derived** from four observable facts, never stored — a stored step index goes stale the moment she uninstalls the connector or moves her User Library. Rust gains three commands: install the connector, report its status, and say whether Live is running.

**Tech Stack:** Tauri 2, React 19, TypeScript 5.8, vitest 4, Rust with serde. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-product-ui-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-19-product-ui-shell.md`. Every screen here is styled by that plan's tokens and hands off to its card. Do not start this plan until that one is merged and green.

## Global Constraints

- **No new dependencies.** In particular, no `tauri-plugin-dialog`: the non-default-User-Library case is handled with a text field she pastes a path into, not a native folder picker. That is a deliberate trade — one fewer dependency for a slightly worse experience in a rare case.
- **Tests are pure functions in `.test.ts` run by vitest.** Rust tests use `std::env::temp_dir()` plus an `AtomicUsize` counter for scratch directories, per `src-tauri/src/settings.rs`.
- **The step is derived from observable facts on every render. Never persist a step index.** A stored index is wrong the moment she uninstalls the connector, moves her library, or opens the app on a second machine.
- **The connector's folder name is read from `shared/connector.json`, never hardcoded in copy.** That folder name is the entry Live shows in its Control Surface dropdown, and the distribution plan renames it. Interpolating the constant is what makes step 3's instructions correct both before and after that rename.
- **Do not perform the rename.** `remote-script/AbletonCopilot/`, the `/live/copilot/*` OSC namespace, `productName`, and `identifier` all stay as they are. This plan only stops hardcoding the name.
- **Never write to Live's `Preferences.cfg`.** The spec rules this out: undocumented format, changes between Live versions, and it holds every preference she has ever set.
- **Step 4's second paragraph is required copy, not decoration.** The product is called Mixing Pal and cannot hear audio; that screen is the one place the gap gets stated before she forms an expectation.
- Verification: `npm test`, `cd src-tauri && cargo test`, `npm run build`. Pipe to a file and grep it.

---

### Task 1: A single source of truth for the connector's folder name

That folder name is what Live shows in its Control Surface dropdown, so step 3's instructions are only correct if they name the real thing. It is also what the distribution plan renames. One constant, read by both languages, with a tripwire that fails if the folder on disk stops matching.

**Files:**
- Create: `shared/connector.json`
- Create: `src-tauri/src/connector.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod connector;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub const FOLDER: &str` and `pub fn folder() -> &'static str` in `src-tauri/src/connector.rs`; `shared/connector.json` importable from TypeScript as `{ folder: string }`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/connector.rs`:

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Manifest {
    folder: String,
}

/// The directory name the Remote Script is installed under, which is also
/// the entry Live shows in Preferences > Link, Tempo & MIDI > Control
/// Surface.
///
/// Read from shared/connector.json rather than written here so the setup
/// screens, the installer, and the repo directory cannot drift apart. The
/// distribution plan renames all three; the test below fails if it renames
/// fewer than all three.
pub fn folder() -> &'static str {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_manifest_names_a_folder_that_actually_exists_in_the_repo() {
        // Two-way tripwire, in the same spirit as
        // wire_version_matches_the_shared_manifest: renaming the directory
        // without the manifest, or the manifest without the directory,
        // produces a setup flow that tells the producer to select an entry
        // Live does not have. That failure is invisible until someone runs
        // the installer against real Live.
        let src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("remote-script")
            .join(folder());
        assert!(
            src.is_dir(),
            "shared/connector.json names {:?}, but remote-script/{} does not exist -- \
             rename both together",
            folder(),
            folder()
        );
    }

    #[test]
    fn the_folder_is_a_bare_directory_name() {
        // It is joined onto a path and shown to a human. A slash would
        // silently install to the wrong place.
        assert!(!folder().contains('/'), "folder must not contain a path separator");
        assert!(!folder().contains('\\'), "folder must not contain a path separator");
        assert!(!folder().is_empty());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `mod connector;` to `src-tauri/src/lib.rs` alongside the other module declarations first, or the file is never compiled.

Run: `cd src-tauri && cargo test connector:: 2>&1 | tee /tmp/f1.log`
Expected: both tests FAIL with `not implemented`.

- [ ] **Step 3: Write the manifest and the implementation**

Create `shared/connector.json`:

```json
{ "folder": "AbletonCopilot" }
```

The value is `AbletonCopilot` today because that is what `remote-script/AbletonCopilot/` is called. The distribution plan changes this file and the directory together, and the test above enforces that it changes both.

Replace the `folder()` stub in `src-tauri/src/connector.rs`:

```rust
/// Parsed once at first use. `include_str!` bakes the manifest into the
/// binary, so a shipped app cannot disagree with the source tree it was
/// built from -- the same reason lib.rs reads shared/wire-version.json
/// this way.
pub fn folder() -> &'static str {
    use std::sync::OnceLock;
    static FOLDER: OnceLock<String> = OnceLock::new();
    FOLDER
        .get_or_init(|| {
            let manifest: Manifest = serde_json::from_str(include_str!("../../shared/connector.json"))
                .expect("shared/connector.json must be valid JSON with a folder field");
            manifest.folder
        })
        .as_str()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test connector:: 2>&1 | tee /tmp/f1.log`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/connector.json src-tauri/src/connector.rs src-tauri/src/lib.rs
git commit -m "Read the connector's folder name from one manifest

That folder name is the entry Live shows in its Control Surface dropdown,
so the setup instructions are only correct if they name the real thing --
and the distribution plan renames it.

The tripwire fails if the manifest and remote-script/ stop agreeing.
Without it, renaming one and not the other produces a setup flow that
tells the producer to select an entry Live does not have, and nothing
catches it until someone runs the installer against real Live."
```

---

### Task 2: Copying the connector into the User Library

The replacement for `scripts/install-remote-script.sh`. The bash version gets one thing subtly right that a naive implementation destroys, and the tests below pin it.

**Files:**
- Create: `src-tauri/src/install.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod install;`)

**Interfaces:**
- Consumes: `connector::folder()` from Task 1.
- Produces: `pub fn sync_dir(src: &Path, dest: &Path, exclude: &[&str]) -> std::io::Result<()>`; `pub fn default_user_library() -> Option<PathBuf>`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/install.rs`:

```rust
use std::path::{Path, PathBuf};

pub fn sync_dir(_src: &Path, _dest: &Path, _exclude: &[&str]) -> std::io::Result<()> {
    unimplemented!()
}

pub fn default_user_library() -> Option<PathBuf> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A unique scratch directory per test, without pulling in a temp-file
    /// crate. Same pattern as settings.rs.
    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mixingpal-install-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    const EXCLUDE: &[&str] = &["logs", "__pycache__"];

    #[test]
    fn a_fresh_install_copies_the_tree() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("__init__.py"), "a");
        write(&src.join("copilot/version.py"), "WIRE_VERSION = 2");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("__init__.py")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(dest.join("copilot/version.py")).unwrap(),
            "WIRE_VERSION = 2"
        );
    }

    #[test]
    fn reinstalling_overwrites_changed_files() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("version.py"), "WIRE_VERSION = 3");
        write(&dest.join("version.py"), "WIRE_VERSION = 2");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("version.py")).unwrap(), "WIRE_VERSION = 3");
    }

    #[test]
    fn reinstalling_removes_files_the_new_version_dropped() {
        // A handler deleted upstream must not keep running inside Live.
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("keep.py"), "keep");
        write(&dest.join("keep.py"), "keep");
        write(&dest.join("gone.py"), "gone");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert!(dest.join("keep.py").exists());
        assert!(!dest.join("gone.py").exists(), "a dropped file must not survive a reinstall");
    }

    #[test]
    fn logs_written_by_a_running_live_session_survive_a_reinstall() {
        // The bug the bash installer already fixed once: an `rm -rf` on the
        // destination deleted logs/ on every reinstall, breaking logging for
        // a Live session that was running at the time. Do not regress this.
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("__init__.py"), "a");
        write(&dest.join("logs/today.log"), "important");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert_eq!(
            std::fs::read_to_string(dest.join("logs/today.log")).unwrap(),
            "important",
            "logs/ is created by a running Live session and is not ours to delete"
        );
    }

    #[test]
    fn compiled_python_is_never_copied_and_never_deleted() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("dest");
        write(&src.join("__init__.py"), "a");
        write(&src.join("__pycache__/stale.pyc"), "junk");
        write(&dest.join("__pycache__/existing.pyc"), "live's own");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert!(!dest.join("__pycache__/stale.pyc").exists(), "never ship a .pyc");
        assert!(dest.join("__pycache__/existing.pyc").exists(), "not ours to delete");
    }

    #[test]
    fn a_destination_whose_parents_do_not_exist_is_created() {
        let root = scratch();
        let src = root.join("src");
        let dest = root.join("a/b/c/dest");
        write(&src.join("__init__.py"), "a");

        sync_dir(&src, &dest, EXCLUDE).unwrap();

        assert!(dest.join("__init__.py").exists());
    }

    #[test]
    fn a_missing_source_is_an_error_rather_than_an_empty_install() {
        // Silently installing nothing would leave Live with a Control
        // Surface entry that loads and does nothing, which is far harder to
        // diagnose than a failed install.
        let root = scratch();
        let result = sync_dir(&root.join("nope"), &root.join("dest"), EXCLUDE);
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `mod install;` to `src-tauri/src/lib.rs`.

Run: `cd src-tauri && cargo test install:: 2>&1 | tee /tmp/f2.log`
Expected: 7 tests FAIL with `not implemented`.

- [ ] **Step 3: Write the implementation**

Replace both stubs in `src-tauri/src/install.rs`:

```rust
/// Mirrors `remote-script/<folder>/` into the installed location.
///
/// Deliberately not "delete the destination and copy": `logs/` is created
/// inside the destination by a running Live session and is not ours. An
/// earlier `rm -rf` here broke logging for a live session mid-build, which
/// is why `exclude` is a parameter and why there is a test for it.
///
/// Excluded names are neither copied from the source nor removed from the
/// destination.
pub fn sync_dir(src: &Path, dest: &Path, exclude: &[&str]) -> std::io::Result<()> {
    if !src.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("connector source not found at {}", src.display()),
        ));
    }
    std::fs::create_dir_all(dest)?;

    let excluded = |name: &std::ffi::OsStr| exclude.iter().any(|e| name == std::ffi::OsStr::new(e));

    // Remove anything in the destination the source no longer has. A
    // handler deleted upstream must not keep running inside Live.
    for entry in std::fs::read_dir(dest)? {
        let entry = entry?;
        let name = entry.file_name();
        if excluded(&name) || src.join(&name).exists() {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if excluded(&name) {
            continue;
        }
        let to = dest.join(&name);
        if entry.file_type()?.is_dir() {
            sync_dir(&entry.path(), &to, exclude)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }

    Ok(())
}

/// Where Live puts the User Library unless the producer moved it.
///
/// Returns None rather than a path that does not exist: creating the
/// directory ourselves would install into somewhere Live never reads, and
/// the producer would be left selecting a Control Surface entry that is
/// not there. Better to say we could not find it and ask.
pub fn default_user_library() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join("Music").join("Ableton").join("User Library");
    path.is_dir().then_some(path)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test install:: 2>&1 | tee /tmp/f2.log`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/install.rs src-tauri/src/lib.rs
git commit -m "Add sync_dir, the connector installer's copy step

Not 'delete the destination and copy': logs/ is created inside the
destination by a running Live session and is not ours. An rm -rf here
already broke logging for a live session once, so the exclusion is a
parameter with a test rather than a comment.

Stale files are still removed -- a handler deleted upstream must not keep
running inside Live -- and a missing source errors rather than silently
installing nothing, which would leave Live with an entry that loads and
does nothing."
```

---

### Task 3: The three Tauri commands

**Files:**
- Modify: `src-tauri/src/install.rs` (add the commands)
- Modify: `src-tauri/src/lib.rs` (register them)

**Interfaces:**
- Consumes: `sync_dir`, `default_user_library`, `connector::folder()`.
- Produces, callable from TypeScript:
  - `invoke<ConnectorStatus>("connector_status")` → `{ folder: string; installed: boolean; user_library: string | null }`
  - `invoke<InstallReport>("install_connector", { userLibrary })` → `{ destination: string }`, where `userLibrary` is `string | null`
  - `invoke<boolean>("live_is_running")`

- [ ] **Step 1: Write the commands**

Append to `src-tauri/src/install.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ConnectorStatus {
    /// The name Live shows in its Control Surface dropdown. The frontend
    /// interpolates this into the setup instructions rather than
    /// hardcoding it, so a rename cannot make the instructions wrong.
    pub folder: String,
    pub installed: bool,
    /// None means we could not find the User Library at its default path.
    pub user_library: Option<String>,
}

#[tauri::command]
pub fn connector_status() -> ConnectorStatus {
    let folder = crate::connector::folder().to_string();
    let library = default_user_library();
    let installed = library
        .as_ref()
        .map(|l| l.join("Remote Scripts").join(&folder).is_dir())
        .unwrap_or(false);
    ConnectorStatus {
        folder,
        installed,
        user_library: library.map(|p| p.display().to_string()),
    }
}

#[derive(Debug, Serialize)]
pub struct InstallReport {
    pub destination: String,
}

/// Where the connector is copied from.
///
/// In a shipped app it is bundled as a Tauri resource. In development
/// that resource does not exist, so it falls back to the repo copy. The
/// distribution plan adds the bundling; this signature does not change
/// when it does -- only which branch is taken.
fn connector_source(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let folder = crate::connector::folder();
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join(folder);
        if bundled.is_dir() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("remote-script")
        .join(folder)
}

/// Copies the connector into the User Library.
///
/// `user_library` overrides the default path, for the producer who moved
/// hers. The frontend sends null unless she typed one.
#[tauri::command]
pub fn install_connector(
    app: tauri::AppHandle,
    user_library: Option<String>,
) -> Result<InstallReport, String> {
    let library = match user_library {
        Some(raw) => {
            let path = PathBuf::from(raw.trim());
            if !path.is_dir() {
                return Err(format!("There's no folder at {}.", path.display()));
            }
            path
        }
        None => default_user_library().ok_or_else(|| {
            "Couldn't find your Ableton User Library where Live usually keeps it. \
             In Live, open Preferences → Library to see where yours is."
                .to_string()
        })?,
    };

    let dest = library.join("Remote Scripts").join(crate::connector::folder());
    sync_dir(&connector_source(&app), &dest, &["logs", "__pycache__"])
        .map_err(|e| format!("Couldn't install the connector: {e}"))?;

    Ok(InstallReport { destination: dest.display().to_string() })
}

/// Whether Ableton Live is running right now.
///
/// Used only to choose which sentence the restart step shows. It is never
/// a gate: arriving deltas are the real evidence that setup worked, and
/// this returning false must not block anyone whose Live is running under
/// a name we did not anticipate.
#[tauri::command]
pub fn live_is_running() -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-Axco", "command"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|line| line.trim() == "Live")
        })
        .unwrap_or(false)
}
```

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs`, extend the `invoke_handler` list:

```rust
            clear_trace,
            window::set_window_mode,
            install::connector_status,
            install::install_connector,
            install::live_is_running
```

- [ ] **Step 3: Build and run the backend suite**

Run: `cd src-tauri && cargo test 2>&1 | tee /tmp/f3.log && cargo build 2>&1 | tee -a /tmp/f3.log`
Expected: all PASS, build clean.

- [ ] **Step 4: Check `live_is_running` against a real machine**

`ps -Axco command` output is not something to take on trust. With Live open, run:

```bash
/bin/ps -Axco command | grep -i live
```

Confirm a line whose trimmed value is exactly `Live`. If the process is named differently on this Live version, fix the comparison and say so in the commit — but keep it a substring-free exact match, because a loose `contains("Live")` matches plenty of unrelated processes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/install.rs src-tauri/src/lib.rs
git commit -m "Add connector_status, install_connector, and live_is_running

install_connector reads its source from a bundled Tauri resource and
falls back to the repo copy in development. The distribution plan adds
the bundling without changing this signature.

live_is_running only chooses which sentence the restart step shows. It is
never a gate -- arriving deltas are the real evidence that setup worked,
so a Live named something we did not anticipate must not block anyone."
```

---

### Task 4: Deriving which step she is on

**Files:**
- Create: `src/setup/step.ts`
- Test: `src/setup/step.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SetupStep = "install" | "open_live" | "control_surface" | "connected" | "account" | "goal" | "done"`; `interface SetupFacts`; `function currentStep(facts: SetupFacts): SetupStep`.

- [ ] **Step 1: Write the failing test**

Create `src/setup/step.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { currentStep, SetupFacts } from "./step";

const DONE: SetupFacts = {
  connectorInstalled: true,
  connectorCurrent: true,
  liveRunning: true,
  deltasArriving: true,
  connectedAcknowledged: true,
  hasAccount: true,
  goalAnswered: true,
};

describe("currentStep", () => {
  it("finishes when every fact is satisfied", () => {
    expect(currentStep(DONE)).toBe("done");
  });

  it("starts at install on a clean machine", () => {
    expect(
      currentStep({
        connectorInstalled: false,
        connectorCurrent: false,
        liveRunning: false,
        deltasArriving: false,
        connectedAcknowledged: false,
        hasAccount: false,
        goalAnswered: false,
      }),
    ).toBe("install");
  });

  // The app updated and the part inside Live did not. Reinstalling is the
  // fix, so it is the same step, not a special case.
  it("returns to install when the connector is out of date", () => {
    expect(currentStep({ ...DONE, connectorCurrent: false })).toBe("install");
  });

  it("asks her to open Live when it is not running", () => {
    expect(
      currentStep({ ...DONE, liveRunning: false, deltasArriving: false, connectedAcknowledged: false }),
    ).toBe("open_live");
  });

  it("asks her to select the Control Surface when Live is up but silent", () => {
    expect(
      currentStep({ ...DONE, deltasArriving: false, connectedAcknowledged: false }),
    ).toBe("control_surface");
  });

  // Deltas are the only real evidence. If they are arriving, whether we
  // managed to spot the Live process is irrelevant -- and a process check
  // that fails on some machine must never strand someone whose setup works.
  it("trusts arriving deltas over a failed process check", () => {
    expect(
      currentStep({ ...DONE, liveRunning: false, connectedAcknowledged: false }),
    ).toBe("connected");
  });

  it("shows the connected screen until she moves past it", () => {
    expect(currentStep({ ...DONE, connectedAcknowledged: false })).toBe("connected");
  });

  it("asks for an account after she has seen it work", () => {
    expect(currentStep({ ...DONE, hasAccount: false })).toBe("account");
  });

  it("asks what she is making last", () => {
    expect(currentStep({ ...DONE, goalAnswered: false })).toBe("goal");
  });

  // The whole point of deriving rather than storing. She uninstalls the
  // connector months later; setup must reopen at install, not at done.
  it("reopens at install when a finished setup is later broken", () => {
    expect(currentStep({ ...DONE, connectorInstalled: false })).toBe("install");
  });

  // Nothing after the Live steps may pre-empt them. Being logged in does
  // not make a disconnected app usable.
  it("never skips the Live steps because the later ones are satisfied", () => {
    expect(
      currentStep({
        ...DONE,
        connectorInstalled: false,
        liveRunning: false,
        deltasArriving: false,
      }),
    ).toBe("install");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/setup/step.test.ts 2>&1 | tee /tmp/f4.log`
Expected: FAIL — cannot resolve `./step`.

- [ ] **Step 3: Write the implementation**

Create `src/setup/step.ts`:

```ts
export type SetupStep =
  | "install"
  | "open_live"
  | "control_surface"
  | "connected"
  | "account"
  | "goal"
  | "done";

/**
 * Everything the step depends on, all of it observable right now.
 *
 * `connectedAcknowledged` is the one piece of session state: the connected
 * screen is something she reads and moves past, and nothing observable
 * records that she has. It resets on relaunch, which is correct -- a
 * finished setup never reaches that step again because `goalAnswered` and
 * `hasAccount` are already true.
 */
export interface SetupFacts {
  connectorInstalled: boolean;
  connectorCurrent: boolean;
  liveRunning: boolean;
  deltasArriving: boolean;
  connectedAcknowledged: boolean;
  hasAccount: boolean;
  goalAnswered: boolean;
}

/**
 * Which step to show, derived fresh every time.
 *
 * Nothing here is stored. A stored step index is wrong the moment she
 * uninstalls the connector, moves her User Library, or opens the app on a
 * machine where setup was already done -- and each of those leaves her
 * looking at a finished setup for an app that does not work.
 *
 * The order is a sequence of gates: each one must be satisfied before the
 * next is even asked about. That is what stops a logged-in account making
 * a disconnected app look ready.
 */
export function currentStep(facts: SetupFacts): SetupStep {
  if (!facts.connectorInstalled || !facts.connectorCurrent) return "install";

  // Deltas are the only real evidence that the whole chain works. A
  // process check that fails on some machine must never strand someone
  // whose setup is fine, so it is only consulted when nothing is arriving.
  if (!facts.deltasArriving) {
    return facts.liveRunning ? "control_surface" : "open_live";
  }

  if (!facts.connectedAcknowledged) return "connected";
  if (!facts.hasAccount) return "account";
  if (!facts.goalAnswered) return "goal";
  return "done";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/setup/step.test.ts 2>&1 | tee /tmp/f4.log`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/setup/step.ts src/setup/step.test.ts
git commit -m "Derive the setup step from observable facts

Nothing is stored. A stored step index is wrong the moment she uninstalls
the connector, moves her User Library, or opens the app on a machine where
setup was already done -- each leaves her looking at a finished setup for
an app that does not work.

Arriving deltas outrank the Live process check, so a process name we did
not anticipate cannot strand someone whose setup already works."
```

---

### Task 5: The setup window

All six screens and the chrome they sit in.

**Files:**
- Create: `src/setup/Setup.tsx`
- Create: `src/setup/Setup.css`
- Create: `src/setup/screens.tsx`
- Create: `public/control-surface.png` (a screenshot — see Step 3)

**Interfaces:**
- Consumes: `currentStep`, `SetupFacts` (Task 4); `connector_status`, `install_connector`, `live_is_running` (Task 3); `loadGoal`/`saveGoal`/`GOAL_MAX_LENGTH` from the shell plan.
- Produces: `<Setup facts={SetupFacts} onFactsChanged={() => void} onAcknowledgeConnected={() => void} onFinished={() => void} />`.

- [ ] **Step 1: Write the stylesheet**

Create `src/setup/Setup.css`:

```css
.setup {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.setup__bar {
  display: flex;
  gap: 6px;
  padding: 14px 26px 0;
}

.setup__tick {
  height: 2px;
  flex: 1;
  border-radius: 2px;
  background: var(--border);
}

.setup__tick--done {
  background: var(--text-faint);
}

.setup__tick--here {
  background: var(--accent);
}

.setup__main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 34px 40px;
}

.setup__label {
  font-size: 11px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.setup__title {
  font-size: 21px;
  line-height: 1.35;
  font-weight: 500;
  color: var(--text);
  margin: 0 0 14px;
}

.setup__body {
  font-size: 15px;
  line-height: 1.65;
  color: var(--text-secondary);
  margin: 0 0 16px;
  max-width: 46ch;
}

.setup__note {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-faint);
  max-width: 46ch;
}

.setup__shot {
  display: block;
  width: 100%;
  max-width: 460px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  margin: 4px 0 16px;
}

.setup__callout {
  border-left: 2px solid var(--accent);
  padding: 2px 0 2px 13px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
  margin: 0 0 16px;
  max-width: 46ch;
}

.setup__footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 40px 26px;
}

.setup__primary {
  background: var(--accent);
  border: none;
  border-radius: var(--radius-control);
  padding: 9px 18px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--surface);
  cursor: pointer;
}

.setup__primary:disabled {
  opacity: 0.55;
  cursor: default;
}

.setup__secondary {
  background: none;
  border: none;
  padding: 9px 4px;
  font: inherit;
  font-size: 13px;
  color: var(--text-faint);
  cursor: pointer;
}

.setup__waiting {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  color: var(--text-muted);
}

.setup__waiting-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--text-muted);
  animation: setup-breathe 2s ease-in-out infinite;
}

@keyframes setup-breathe {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .setup__waiting-dot {
    animation: none;
  }
}

.setup__ok-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--ok);
  box-shadow: 0 0 9px rgba(94, 214, 160, 0.75);
  display: inline-block;
  margin-right: 9px;
}

.setup__field {
  width: 100%;
  max-width: 420px;
  box-sizing: border-box;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 9px 11px;
  font: inherit;
  font-size: 14px;
  color: var(--text);
  outline: none;
  margin-bottom: 14px;
}

.setup__field:focus {
  border-color: var(--border-strong);
}

.setup__error {
  background: rgba(224, 108, 92, 0.1);
  border: 1px solid rgba(224, 108, 92, 0.28);
  border-radius: var(--radius-control);
  padding: 11px 13px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-secondary);
  max-width: 46ch;
  margin-bottom: 14px;
}
```

- [ ] **Step 2: Write the screens**

Create `src/setup/screens.tsx`. Each screen is a plain function of props so the copy lives in one readable place:

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GOAL_MAX_LENGTH } from "../ui/goal";

/** Every screen after "install" names the connector as Live shows it. */
export function InstallScreen({
  folder,
  onInstalled,
}: {
  folder: string;
  onInstalled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState("");
  const [askingForLibrary, setAskingForLibrary] = useState(false);

  async function install() {
    setBusy(true);
    setError(null);
    try {
      await invoke("install_connector", {
        userLibrary: askingForLibrary && library.trim() !== "" ? library.trim() : null,
      });
      onInstalled();
    } catch (e) {
      setError(String(e));
      // The one failure she can actually fix herself: we looked in the
      // usual place and her library is somewhere else.
      setAskingForLibrary(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="setup__label">Step 1 of 4</div>
      <h1 className="setup__title">Mixing Pal needs a small connector inside Live.</h1>
      <p className="setup__body">
        It goes into your Ableton User Library, where Live keeps the things you add
        yourself. Nothing else on your computer is touched.
      </p>
      {error !== null && <div className="setup__error">{error}</div>}
      {askingForLibrary && (
        <input
          className="setup__field"
          value={library}
          placeholder="/Users/you/Music/Ableton/User Library"
          onChange={(e) => setLibrary(e.target.value)}
        />
      )}
      <button className="setup__primary" onClick={install} disabled={busy}>
        {busy ? "Installing…" : askingForLibrary ? "Try again" : "Install it"}
      </button>
      <p className="setup__note" style={{ marginTop: 14 }}>
        It will appear in Live as <b>{folder}</b>.
      </p>
    </>
  );
}

export function OpenLiveScreen() {
  return (
    <>
      <div className="setup__label">Step 2 of 4</div>
      <h1 className="setup__title">Now open Ableton Live.</h1>
      <p className="setup__body">
        Live only looks for connectors when it starts, so if it was already open,
        quit it and open it again.
      </p>
      <div className="setup__waiting">
        <span className="setup__waiting-dot" />
        Waiting for Live…
      </div>
    </>
  );
}

export function ControlSurfaceScreen({ folder }: { folder: string }) {
  return (
    <>
      <div className="setup__label">Step 3 of 4</div>
      <h1 className="setup__title">Turn it on inside Live.</h1>
      <p className="setup__body">
        Open <b>Preferences → Link, Tempo &amp; MIDI</b>, and choose <b>{folder}</b> as a
        Control Surface.
      </p>
      <img
        className="setup__shot"
        src="/control-surface.png"
        alt={`Live's Link, Tempo and MIDI preferences, with ${folder} chosen as a Control Surface and Input and Output left as None`}
      />
      {/* The thing people get wrong, and the reason this screen has a
          callout rather than just a picture. */}
      <div className="setup__callout">Leave Input and Output set to None.</div>
      <div className="setup__waiting">
        <span className="setup__waiting-dot" />
        Waiting for Live to say hello…
      </div>
      <p className="setup__note" style={{ marginTop: 14 }}>
        If you just installed the connector and {folder} isn't in the list, quit Live and
        open it again — it only looks for connectors at startup.
      </p>
    </>
  );
}

export function ConnectedScreen({
  trackCount,
  trackNames,
  onContinue,
}: {
  trackCount: number;
  trackNames: string[];
  onContinue: () => void;
}) {
  const named = trackNames.filter((n) => n.trim() !== "").slice(0, 4);
  return (
    <>
      <div className="setup__label">Step 4 of 4</div>
      <h1 className="setup__title">
        <span className="setup__ok-dot" />
        Connected.
      </h1>
      {/* Proof, and the moment the setup pays for itself. This is the one
          place in the product where mirroring Live earns its keep. */}
      <p className="setup__body">
        I can see <b>{trackCount} {trackCount === 1 ? "track" : "tracks"}</b>
        {named.length > 0 && <> — {named.join(", ")}…</>}
      </p>
      {/* Required copy, not decoration. The product is called Mixing Pal
          and it cannot hear audio; this is the one screen that says so
          before she forms an expectation it cannot meet. Do not shorten
          this, and do not move it into fine print. */}
      <p className="setup__body">
        I read your settings — devices, faders, routing, notes. I can't hear your audio,
        so I'll never tell you something sounds muddy. I'll tell you what's set to what,
        and what that usually means.
      </p>
      <button className="setup__primary" onClick={onContinue}>
        Got it
      </button>
    </>
  );
}

/**
 * A placeholder in the sense that it talks to nothing yet -- the model
 * access plan fills in what it calls. The screen itself is real, and it is
 * deliberately placed after Connected: she reaches a working, visible
 * result in three steps, and only then is asked for something she has to
 * go and find.
 */
export function AccountScreen({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <div className="setup__label">Almost there</div>
      <h1 className="setup__title">Enter your invite code.</h1>
      <p className="setup__body">This is what lets Mixing Pal answer questions.</p>
      <input className="setup__field" placeholder="MP-0000-0000" />
      <button className="setup__primary" onClick={onContinue}>
        Continue
      </button>
    </>
  );
}

export function GoalScreen({
  goal,
  onGoalChange,
  onFinish,
}: {
  goal: string;
  onGoalChange: (value: string) => void;
  onFinish: () => void;
}) {
  return (
    <>
      <div className="setup__label">Last thing</div>
      <h1 className="setup__title">What are you making?</h1>
      <p className="setup__body">
        A few words is plenty. It's the difference between advice about music and advice
        about <em>your</em> track — and you can change it any time.
      </p>
      <input
        className="setup__field"
        autoFocus
        value={goal}
        maxLength={GOAL_MAX_LENGTH}
        placeholder="dark garage, 2am"
        onChange={(e) => onGoalChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onFinish()}
      />
      <button className="setup__primary" onClick={onFinish}>
        Start
      </button>
      <button className="setup__secondary" onClick={onFinish}>
        Skip
      </button>
    </>
  );
}
```

- [ ] **Step 3: Capture the screenshot**

Take a real screenshot of Live's **Preferences → Link, Tempo & MIDI** pane on the Live version this is being built against, with the connector selected as a Control Surface and Input and Output left as None. Crop to the Control Surface block. Save as `public/control-surface.png`, no wider than 920px.

A drawing will not do. The point of this screen is that she can compare what is in front of her to what is on screen, and an approximation makes that comparison harder rather than easier.

Add to `docs/manual-verification.md`:

```markdown
- [ ] `public/control-surface.png` matches the Live version being shipped
      against. Re-capture it whenever Live's preferences layout changes —
      a stale screenshot of this one pane is the single most likely cause
      of a failed first run.
```

- [ ] **Step 4: Write the setup shell**

Create `src/setup/Setup.tsx`:

```tsx
import "./Setup.css";
import { SetupFacts, SetupStep, currentStep } from "./step";
import {
  AccountScreen,
  ConnectedScreen,
  ControlSurfaceScreen,
  GoalScreen,
  InstallScreen,
  OpenLiveScreen,
} from "./screens";

/** Which of the four numbered ticks a step falls under. */
const TICK: Record<SetupStep, number> = {
  install: 0,
  open_live: 1,
  control_surface: 2,
  connected: 3,
  account: 3,
  goal: 3,
  done: 3,
};

export function Setup({
  facts,
  folder,
  trackCount,
  trackNames,
  goal,
  onGoalChange,
  onFactsChanged,
  onAcknowledgeConnected,
  onFinished,
}: {
  facts: SetupFacts;
  folder: string;
  trackCount: number;
  trackNames: string[];
  goal: string;
  onGoalChange: (value: string) => void;
  onFactsChanged: () => void;
  onAcknowledgeConnected: () => void;
  onFinished: () => void;
}) {
  const step = currentStep(facts);
  const here = TICK[step];

  return (
    <div className="setup" data-tauri-drag-region>
      <div className="setup__bar">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`setup__tick ${
              i < here ? "setup__tick--done" : i === here ? "setup__tick--here" : ""
            }`}
          />
        ))}
      </div>
      <div className="setup__main">
        {step === "install" && <InstallScreen folder={folder} onInstalled={onFactsChanged} />}
        {step === "open_live" && <OpenLiveScreen />}
        {step === "control_surface" && <ControlSurfaceScreen folder={folder} />}
        {step === "connected" && (
          <ConnectedScreen
            trackCount={trackCount}
            trackNames={trackNames}
            onContinue={onAcknowledgeConnected}
          />
        )}
        {step === "account" && <AccountScreen onContinue={onFinished} />}
        {step === "goal" && (
          <GoalScreen goal={goal} onGoalChange={onGoalChange} onFinish={onFinished} />
        )}
      </div>
      <div className="setup__footer" />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run 2>&1 | tee /tmp/f5.log && npm run build 2>&1 | tee -a /tmp/f5.log`
Expected: all PASS. The orphan-token test now covers `Setup.css`.

`App.tsx` does not render `<Setup>` until Task 6, so the build may report it as unused — that is expected.

- [ ] **Step 6: Commit**

```bash
git add src/setup docs/manual-verification.md public/control-surface.png
git commit -m "Add the setup window and its six screens

The connected screen carries the copy that scopes what Mixing Pal means:
it reads settings and cannot hear audio. That paragraph is required, not
decoration -- the name promises listening, and this is the one screen
that corrects the promise before she forms an expectation.

Step 3 uses a real screenshot rather than a drawing. The point is that she
can compare what is in front of her to what is on screen, and an
approximation makes that comparison harder."
```

---

### Task 6: Wire setup into the app

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/ui/windowMode.ts` — no change expected; confirm `setup_finished` is dispatched

**Interfaces:**
- Consumes: everything from Tasks 3–5, plus the shell plan's `nextMode`, `MODE_GEOMETRY`, `Card`, `Pill`.
- Produces: the running first-run flow.

- [ ] **Step 1: Add the facts-gathering effect to `App.tsx`**

Insert above the existing return, after the `connected` derivation:

```tsx
  const [folder, setFolder] = useState("");
  const [connectorInstalled, setConnectorInstalled] = useState<boolean | null>(null);
  const [liveRunning, setLiveRunning] = useState(false);
  const [connectedAcknowledged, setConnectedAcknowledged] = useState(false);
  const [goalAnswered, setGoalAnswered] = useState(() => loadGoal().trim() !== "");

  const refreshConnector = useCallback(() => {
    invoke<{ folder: string; installed: boolean }>("connector_status")
      .then((s) => {
        setFolder(s.folder);
        setConnectorInstalled(s.installed);
      })
      .catch((err) => console.error("failed to read connector status", err));
  }, []);

  useEffect(refreshConnector, [refreshConnector]);

  // Polled only while setup is on screen. Once she is past it there is
  // nothing to decide, and a process scan every two seconds forever is a
  // cost with no buyer.
  useEffect(() => {
    if (mode !== "setup") return;
    const poll = () => {
      invoke<boolean>("live_is_running").then(setLiveRunning).catch(() => setLiveRunning(false));
      refreshConnector();
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [mode, refreshConnector]);

  const facts: SetupFacts = {
    connectorInstalled: connectorInstalled ?? true,
    // A version mismatch means the app updated and the part inside Live
    // did not, and reinstalling is the fix -- the same fix as a missing
    // connector, so it is the same step.
    connectorCurrent: state.scriptVersion === null || state.scriptVersion === wireVersion.version,
    liveRunning,
    deltasArriving: connected,
    connectedAcknowledged,
    hasAccount: true, // the model-access plan replaces this
    goalAnswered,
  };

  // connector_status has not answered yet on the very first render.
  // Guessing "not installed" would flash the setup window at someone whose
  // setup has been finished for months.
  const setupNeeded = connectorInstalled !== null && currentStep(facts) !== "done";

  useEffect(() => {
    if (setupNeeded) setMode("setup");
    else dispatch({ type: "setup_finished" });
  }, [setupNeeded, dispatch]);
```

Add the imports:

```tsx
import wireVersion from "../shared/wire-version.json";
import { Setup } from "./setup/Setup";
import { SetupFacts, currentStep } from "./setup/step";
import { loadGoal, saveGoal } from "./ui/goal";
```

- [ ] **Step 2: Render setup as a third branch**

Replace the JSX return:

```tsx
  const trackNames = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => state.tracks[i].name ?? "");

  return (
    <div ref={root}>
      {mode === "setup" ? (
        <Setup
          facts={facts}
          folder={folder}
          trackCount={trackNames.length}
          trackNames={trackNames}
          goal={goal}
          onGoalChange={(v) => {
            setGoal(v);
            saveGoal(v);
          }}
          onFactsChanged={refreshConnector}
          onAcknowledgeConnected={() => setConnectedAcknowledged(true)}
          onFinished={() => {
            setGoalAnswered(true);
            dispatch({ type: "setup_finished" });
          }}
        />
      ) : mode === "card" ? (
        /* ...the existing Card branch, unchanged... */
      ) : (
        /* ...the existing Pill branch, unchanged... */
      )}
    </div>
  );
```

The goal now lives in `App.tsx` so setup and the card share one value. Lift `const [goal, setGoal] = useState(loadGoal)` out of `Card.tsx` into `App.tsx`, and pass `goal` and `onGoalChange` down to `<Card>` as props. Update `Card.tsx`'s props type to match and delete its own `useState(loadGoal)`.

- [ ] **Step 3: Typecheck and run everything**

Run: `npm run build 2>&1 | tee /tmp/f6.log && npx vitest run 2>&1 | tee -a /tmp/f6.log && cd src-tauri && cargo test 2>&1 | tee -a /tmp/f6.log`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/ui/Card.tsx
git commit -m "Wire the setup flow into the app

The goal is lifted into App.tsx so setup and the card share one value
rather than two components each loading it from storage.

Setup opens only once connector_status has actually answered: guessing
'not installed' on the first render would flash the setup window at
someone whose setup has been finished for months.

Live process polling stops when setup does -- a process scan every two
seconds forever is a cost with no buyer."
```

---

### Task 7: Give the failure banners something to do

The shell plan re-dressed the banners with the right words. The spec also asks each one to end in a control that does the fixable part, which needed the setup flow to exist.

**Files:**
- Modify: `src/ui/Connection.tsx`
- Modify: `src/ui/Card.tsx`, `src/App.tsx` (pass the handlers through)

**Interfaces:**
- Consumes: `install_connector` (Task 3).
- Produces: `<Connection lastSeen={...} scriptVersion={...} onShowSetup={() => void} />`.

- [ ] **Step 1: Add the actions**

In `src/ui/Connection.tsx`, add `onShowSetup: () => void` to the `Connection` component's props and a control to the three actionable banners. `selectBanner` and every constant above it stay untouched.

For `not_connected`, after the sentence:

```tsx
          <button className="banner__action" onClick={onShowSetup}>
            Show me where →
          </button>
```

For `version_mismatch` and `stale_script`, the same button with the label `Reinstall the connector →`. Both reopen setup, which derives its own step — a stale connector lands on `install` because `connectorCurrent` is false, and that is exactly the screen with the install button on it. There is no second install path to keep in sync.

Add to `src/ui/Connection.css`:

```css
.banner__action {
  display: block;
  background: none;
  border: none;
  padding: 8px 0 0;
  font: inherit;
  font-size: 13px;
  color: var(--accent);
  cursor: pointer;
}
```

That is the second and last use of the accent in the card view when a banner is showing — the nudge rule is the other. If a banner and a nudge are on screen together the count is three, so the nudge slot is hidden while any banner is showing. Add that condition in `Card.tsx`:

```tsx
      {nudge !== null && !connected === false && (
```

is wrong — write it explicitly instead:

```tsx
      {nudge !== null && connected && (
        <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />
      )}
```

A nudge about track names while the app is disconnected is noise anyway: she cannot act on advice from an app that is not reading her set.

- [ ] **Step 2: Thread the handler**

`App.tsx` passes `onShowSetup={() => setMode("setup")}` to `<Card>`, which passes it to `<Connection>`. Add the prop to both types.

Setup opened this way derives its own step from the same facts, so it shows install for a stale connector and control_surface for a silent Live — no separate entry points.

- [ ] **Step 3: Typecheck and run everything**

Run: `npm run build 2>&1 | tee /tmp/f7.log && npx vitest run 2>&1 | tee -a /tmp/f7.log`
Expected: all green, and `git diff src/ui/Connection.test.ts` reports no change.

- [ ] **Step 4: Commit**

```bash
git add src/ui/Connection.tsx src/ui/Connection.css src/ui/Card.tsx src/App.tsx
git commit -m "Give the failure banners a control that fixes the problem

All three reopen setup, which derives its own step -- a stale connector
lands on the install screen because connectorCurrent is false. There is no
second install path to keep in sync.

The nudge slot hides while a banner shows: it would be the third use of
the accent in one view, and advice about track names is noise from an app
that is not reading the set."
```

---

### Task 8: Verify against real Live

Nothing above proves the thing works. This does, and it is the only task that cannot be automated.

**Files:**
- Modify: `docs/manual-verification.md`

- [ ] **Step 1: Run a genuine clean first run**

Remove the installed connector and every trace of setup, then launch:

```bash
rm -rf "$HOME/Music/Ableton/User Library/Remote Scripts/AbletonCopilot"
npm run tauri dev
```

Also clear `localStorage` in the webview devtools so the goal is empty.

Walk the whole flow with Live closed at the start. Confirm each of:

1. Setup opens centred, not on top of everything, and is draggable.
2. **Install** copies the connector. `ls "$HOME/Music/Ableton/User Library/Remote Scripts/"` shows the folder.
3. Opening Live advances the step on its own, with no button pressed.
4. **Step 3's screenshot matches what is actually in front of you.** If it does not, re-capture it — this is the step that decides whether a stranger gets through setup.
5. Selecting the Control Surface advances to Connected within a few seconds, again with no button.
6. The connected screen names **real track names from the open set**, and carries the "I can't hear your audio" paragraph.
7. Finishing shrinks the window into the card at the card's size, in one step, with no intermediate flash of the wrong geometry.
8. Quitting and relaunching goes **straight to the card**. Setup does not reappear.
9. Deleting the connector folder and relaunching **does** reopen setup, at the install step.

- [ ] **Step 2: Verify the reinstall path preserves logs**

With Live running and the connector installed, confirm `logs/` exists in the installed folder, then press the reinstall action from the version-mismatch banner (or call `install_connector` from devtools). Confirm `logs/` and its contents survive. This is the regression the bash installer already suffered once.

- [ ] **Step 3: Record it all**

Append to `docs/manual-verification.md`:

```markdown
## First run (added 2026-08-19)

Run from a genuinely clean state — delete
`~/Music/Ableton/User Library/Remote Scripts/<connector folder>` and clear
the webview's localStorage first. A rerun on an already-set-up machine
proves nothing about the flow this exists to test.

Date: ___________  Live version: ___________  Tester: ___________

- [ ] Setup opens centred and is not always-on-top. It can be dragged.
- [ ] Install puts the connector in the User Library. Verify by listing
      the Remote Scripts directory, not by trusting the success screen.
- [ ] Opening Live advances the step with no button pressed.
- [ ] The step-3 screenshot matches this Live version's preferences pane.
      If it does not, re-capture `public/control-surface.png` — this is the
      step that decides whether a stranger completes setup.
- [ ] Selecting the Control Surface advances to Connected on its own.
- [ ] The connected screen names real tracks from the open set, and shows
      the "I read your settings … I can't hear your audio" paragraph.
- [ ] Finishing shrinks straight into the card, with no flash of the wrong
      window size.
- [ ] Relaunching goes straight to the card. Setup does not reappear.
- [ ] Deleting the connector folder and relaunching reopens setup at the
      install step.
- [ ] Reinstalling over an existing install preserves `logs/` and its
      contents. A running Live session writes there and an earlier
      installer deleted it on every reinstall.
- [ ] A non-default User Library: move it, relaunch, confirm the install
      step reports that it could not find the library and accepts a pasted
      path.
```

- [ ] **Step 4: Commit**

```bash
git add docs/manual-verification.md
git commit -m "Record the first-run manual verification

Must be run from a genuinely clean state. A rerun on an already-set-up
machine proves nothing about the flow it exists to test, which is the
easiest way for this checklist to become theatre."
```

---

## Self-Review

**Spec coverage.** First run steps 1–6: Tasks 5 and 6. Resumability by derivation: Task 4. Failure states with actions: Task 7 (the copy landed in the shell plan). `install_connector` and the other commands: Tasks 2 and 3. "Not automated, deliberately": honoured — nothing writes `Preferences.cfg`, and Task 3's `live_is_running` is explicitly not a gate. The account step placed after Connected: Task 4's ordering and Task 5's `AccountScreen`.

**One thing the spec did not anticipate, resolved here.** The spec assigns the rename to the distribution plan but has first run tell the producer to select **Mixing Pal** in Live's dropdown — while the folder is still `AbletonCopilot`, which would make the central instruction of the central step wrong. Task 1 fixes it properly: the name comes from `shared/connector.json`, interpolated into every screen, with a tripwire that fails if the manifest and the directory stop agreeing. First run is now correct both before and after the rename, and the rename stays where the spec put it.

**Deferred, not dropped.** `AccountScreen` renders but talks to nothing; the model-access plan wires it and replaces `hasAccount: true`. The reader panel is out of scope per the spec.

**Placeholder scan.** No TBDs. The one asset that cannot be written as code — `public/control-surface.png` — has explicit capture instructions, a stated quality bar, and a manual-verification item that catches it going stale.

**Type consistency.** `SetupFacts`' seven fields are constructed in `App.tsx` (Task 6) exactly as declared in `src/setup/step.ts` (Task 4). `ConnectorStatus`'s `folder`/`installed`/`user_library` match the `invoke` type annotation in Task 6. `install_connector`'s `user_library: Option<String>` is invoked as `{ userLibrary }`, which is Tauri's camelCase argument convention — the same convention `save_settings` already relies on with `baseUrl` and `modelName`.
