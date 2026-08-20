# Distribution — Design

Date: 2026-08-20
Status: approved for planning
Subsystem **A** of `2026-08-19-product-ui-design.md`. Subsystem C (Product UI) is
built. This document is A. Subsystem B (Model access) is still unwritten.

## Why this exists

There is no artifact. The app runs from `npm run tauri dev` inside a checkout,
which means the only people who can run it are people who can clone a repo and
install a Rust toolchain. The person this is being built for is not one of them.

One defect makes this concrete. `connector_source` in `src-tauri/src/install.rs`
looks for the Remote Script in the app's resource directory and falls back to
`env!("CARGO_MANIFEST_DIR")/../remote-script` — a path baked in at compile time,
pointing at the machine that did the compiling. `tauri.conf.json` has no
`bundle.resources` key, so the resource never exists and the fallback always
wins. On any computer but the build machine, the first step of first run fails.

The code was written for the fix. The comment above `connector_source` says so:
*"In a shipped app it is bundled as a Tauri resource... The distribution plan
adds the bundling; this signature does not change when it does."* This is that
plan.

## Scope

**In:** bundling the Remote Script as a resource; a universal macOS binary; a
`.dmg`; Apple Developer enrollment; Developer ID signing; notarization and
stapling; release CI on tag; artifact hosting; `tauri-plugin-updater`; a
first-run verification pass on a Mac that has never seen this repo.

**Out:**

- **Model access.** Stage 1 ships an app that installs cleanly and then cannot
  answer anything, because `run_model` refuses while `model` or `api_key` is
  empty and nothing in setup sets either. For her, that is one manual step you
  perform once. For beta testers it is a real gap, and it closes in subsystem
  B's spec, not this one.
- **Windows and Linux.** `default_user_library` builds
  `~/Music/Ableton/User Library`, the macOS layout. Windows keeps it under
  `Documents` and needs its own installer, signing story, and CI runner.
- **The Mac App Store.** Sandboxing forbids writing into another app's User
  Library, which is the entire point of the connector.
- **Telemetry and crash reporting.**
- **The dead `AccountScreen`** (`src/setup/screens.tsx:155`) and the
  `hasAccount: true` hardcode at `src/App.tsx:112`. Both belong to subsystem B.

## Principles

These extend the product spec's principles; they do not replace them.

**An install is something you finish, not something you configure.** Every step
that needs a terminal is a defect. `xattr -dr com.apple.quarantine` is a correct
command and an unacceptable instruction: it teaches the target user to disable a
security control on request, which is indistinguishable from what malware asks
for.

**The bundle is the only source of truth for the connector.** Nothing the app
installs may come from the machine that built it.

**Ship the boring artifact.** A `.dmg` that opens to an app icon and an
Applications folder is the interaction every Mac user already knows. Nothing
here is a place to be novel.

**Updates are maintenance, not news.** The product spec's "quiet by default,
words only on failure" applies. An update that works says nothing.

**Verify on a machine that has never seen the repo.** A build that works on the
build machine has demonstrated nothing about distribution.

## Stages

Three stages, each of which ends somewhere you could stop shipping.

| | Stage | Ends with | Blocked by |
| --- | --- | --- | --- |
| **1** | It installs and runs | A universal `.dmg` that works on a clean Mac | nothing |
| **2** | It installs without a fight | A signed, notarized, stapled app | Apple enrollment |
| **3** | It updates itself | Tagged release CI, hosted artifacts, in-app updates | stage 2 |

Stage 1 goes first because it is the only stage that can fail in a way that
teaches you something. Nothing in this app has run against real Ableton Live
beyond one session on the build machine. Stage 1's deliverable is not really a
`.dmg` — it is the answer to *does this work on a computer that is not mine*.

---

## Stage 1 — It installs and runs

### The connector becomes a bundled resource

Add to `tauri.conf.json`:

```json
"resources": { "../remote-script/MixingPal/": "MixingPal/" }
```

This is verified, not assumed. With that key set, a built bundle contains all
36 connector files at `Contents/Resources/MixingPal/`, including
`mixingpal/version.py` — the exact marker file `connector_status` checks — with
no `__pycache__` or `logs` leakage. `resource_dir()` returns
`Contents/Resources` on macOS and `connector_source` joins
`connector::folder()` onto it, so the existing Rust code finds it with no
change.

**This needs a tripwire.** The destination string and `connector::folder()` must
agree, and nothing in the type system makes them. The rename from
`AbletonCopilot` to `MixingPal` already came close to leaving one of these
behind. A build where they disagree does not fail — it silently ships an app
with no connector, and on the build machine the `CARGO_MANIFEST_DIR` fallback
hides it. Add a Rust test that parses `tauri.conf.json` and asserts the
`bundle.resources` destination equals `connector::folder()`, in the same idiom
as the existing `include_str!` tripwires.

Because that tripwire holds, `connector_source` gains no new error branch for a
missing resource. That case cannot happen in a build that passes tests, and the
repo does not add handling for what cannot happen.

### A universal binary

`x86_64-apple-darwin` is not installed on the build machine — only
`aarch64-apple-darwin`. Install it, then build with
`--target universal-apple-darwin` so one artifact runs on Apple Silicon and
Intel.

Set `bundle.macOS.minimumSystemVersion` explicitly. Tauri's default is `10.13`,
which is older than anything that matters here and older than Live 12 supports.
`10.15` is the proposed floor — see Open questions.

### The DMG

- `bundle.targets` becomes the explicit `["app", "dmg"]`. On macOS `"all"`
  already means these two, so this changes nothing today and stops stage 3's
  updater artifacts from arriving as a surprise.
- `bundle.category` becomes `"public.app-category.music"`.
- `bundle.macOS.dmg` sets `appPosition` and `applicationFolderPosition` so the
  drag target is unmissable. No custom background art in this stage.

### Delivery, and the Gatekeeper problem

`com.apple.quarantine` is set by the application that receives the file. A
browser download sets it. AirDrop sets it. A copy over USB, SMB, or `scp` does
not.

This produces two different first runs from the same unsigned `.dmg`:

- **Hand-carried to her over USB or the local network:** no quarantine bit, no
  Gatekeeper, no warning. She drags and double-clicks. This is the stage 1
  delivery path and it is genuinely clean.
- **Downloaded by a beta tester:** quarantined, and macOS blocks it. Control-
  click → Open no longer bypasses this; Apple removed that in Sequoia. The only
  route is launch, get refused, then System Settings → Privacy & Security →
  "Open Anyway", then launch again.

Stage 1 therefore ships a short written page alongside any download, with
screenshots of that sequence. Stage 2 deletes the page.

### Verification

A fresh macOS user account is a real clean room for this, and it is free.
`~/Music/Ableton/User Library` is per-user, Live is installed system-wide in
`/Applications`, and the account has no repo, no Rust toolchain, and no
`CARGO_MANIFEST_DIR` to fall back to. Create one, copy the `.dmg` across, and
walk the whole first run: install the connector, start Live, add the control
surface, watch deltas arrive, ask a question.

Fold the result into `docs/manual-verification.md`, which already exists for
exactly this.

This pass also answers a question stage 2 depends on: whether writing into
`~/Music/Ableton` raises a macOS privacy prompt. It may not — that directory is
not obviously in the protected set — but the answer should be observed rather
than reasoned about, and this test observes it for free.

---

## Stage 2 — It installs without a fight

### Enrollment

Apple Developer Program, **individual**, $99/year. Individual enrollment is
usually approved within 24–48 hours. Organization enrollment requires a D-U-N-S
number for the legal entity, which is free but takes up to five business days
to issue before Apple's own review even starts. The only difference visible to
a user is the name macOS shows, and an individual account can move to an
organization later.

The existing `Apple Development: p.guseva00@gmail.com (77WH2GLM9G)` identity
does not help. Development certificates authorize apps on machines enrolled in
a development profile; an app signed with one is rejected on any other Mac,
which is worse than shipping unsigned. Distribution needs a **Developer ID
Application** certificate, which only the paid membership issues.

### Signing and notarization

- `hardenedRuntime` already defaults to `true` in Tauri 2.11, which
  notarization requires. No entitlements file is expected: the app is not
  sandboxed, so outbound UDP and HTTPS need no entitlement, and WKWebView runs
  JavaScript in a separate system process, so the app needs no JIT entitlement
  of its own. Confirm with `codesign -d --entitlements` rather than assuming.
- Signing identity comes from `APPLE_SIGNING_IDENTITY`; in CI the certificate
  arrives as base64 `APPLE_CERTIFICATE` plus `APPLE_CERTIFICATE_PASSWORD`.
- Notarize with an **App Store Connect API key** (`APPLE_API_ISSUER`,
  `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) rather than an Apple ID and
  app-specific password. The API key is not bound to a human's 2FA and does not
  break when a password rotates.
- Staple the ticket to both the `.app` and the `.dmg`, so a first launch works
  with no network.

### Verification

`spctl -a -vvv -t install` on the `.app` must report `accepted` and name the
Developer ID. `xcrun stapler validate` must pass on the `.dmg`. Then download
the `.dmg` through a browser — deliberately acquiring the quarantine bit — and
confirm it opens with no dialog at all.

### What this fixes beyond the warning

macOS keys an app's privacy permissions to its code signature. An ad-hoc signed
build gets a new signature every time it is built, so each update looks like a
different application and starts from zero. A stable Developer ID makes those
grants persist across updates. Whether this app needs any such grant is what
stage 1's clean-account run determines; if it does, stage 3 is not safe to
build on ad-hoc signing.

---

## Stage 3 — It updates itself

### Artifacts

Set `bundle.createUpdaterArtifacts: true`. The macOS build then also emits
`Mixing Pal.app.tar.gz` and a `.sig` beside the `.dmg`.

Generate an update keypair with `tauri signer generate`. The public key goes
into `plugins.updater.pubkey` in `tauri.conf.json` and is committed. The private
key and its password become CI secrets. This keypair is minisign and has nothing
to do with Apple signing; it authenticates the update payload, while Apple's
signature authenticates the app to macOS.

### Hosting

Cloudflare R2, S3-compatible, no egress fees. CI uploads the `.dmg`, the
`.app.tar.gz`, its `.sig`, and a `latest.json` manifest. `plugins.updater.endpoints`
points at that manifest over plain HTTPS, so nothing needs a GitHub token and
the source repository stays private.

`latest.json` lists `darwin-aarch64` and `darwin-x86_64`, both pointing at the
same universal artifact.

The updater also needs `updater:default` and `process:allow-restart` added to
`src-tauri/capabilities/default.json`.

### Release CI

GitHub Actions, triggered on a `v*` tag. Import the certificate, add both Rust
targets, build universal, sign, notarize, staple, upload to R2, write
`latest.json`. Secrets: the two Apple certificate values, the three App Store
Connect API key values, the two Tauri signing values, and R2 credentials.

### How an update behaves

Check on launch. Download quietly. Do not interrupt a session to install:
`downloadAndInstall` replaces the bundle on disk and the replacement takes
effect at the next launch, which is quiet by construction. Say nothing when
this works.

A failed check or download is not something she can act on, so it does not
produce words either — it goes to the existing trace and is retried at the next
launch. The accepted risk is that a persistently failing updater leaves someone
on an old build silently. At beta scale, with a list of testers you can contact,
that is the right trade.

### The connector after an app update

An app update carries a new connector inside its bundle, but the copy in her
User Library only changes when `install_connector` runs. This is already
handled: `connector_status` reports `connectorCurrent`, `needsSetup` reopens
setup when the connector is stale, and the setup machine already has
`open_live` and `control_surface` steps. Stage 3 inherits the path rather than
building it.

One copy change is needed. Reaching the install step after an update is a
different situation from reaching it on a first run, and the screen should say
why it is back and that Live must be restarted before a new Remote Script
loads. Restarting Live is unavoidable — Live reads Remote Scripts at startup.

### Version numbering

`tauri.conf.json`'s `version` is authoritative. `Cargo.toml` and `package.json`
carry their own copies, and a tripwire test asserts all three agree.

This is a different number from the connector's wire version in
`mixingpal/version.py`, which the existing handshake compares. The two must not
be conflated: the app version describes the download, the wire version
describes whether two components can talk.

---

## Testing

Automated, in the repo's existing tripwire idiom:

- `bundle.resources`' destination equals `connector::folder()`.
- The three version strings agree.

Manual, in `docs/manual-verification.md`:

- Full first run in a fresh macOS user account, from `.dmg` to an answered
  question (stage 1).
- `spctl` and `stapler` checks, plus a browser-downloaded `.dmg` that opens with
  no dialog (stage 2).
- Install `0.1.0`, publish `0.1.1`, confirm the app updates itself and that
  setup then reinstalls the connector (stage 3).

## A note for planning

Two plans, split at the enrollment boundary:

- **Plan 1 — stage 1.** Config, the resource tripwire, the universal build, the
  clean-account verification pass. Small, and it ships without waiting on Apple.
- **Plan 2 — stages 2 and 3.** Both need the Developer ID certificate in hand:
  stage 3's CI exists to sign and notarize, so it cannot be built or tested
  before stage 2 has a certificate to build it around.

Plan 1 has no dependency on plan 2. Plan 2 cannot go first.

## Open questions

1. **`minimumSystemVersion`.** `10.15` is proposed as matching Live 12's floor.
   Confirm against Ableton's actual system requirements before setting it;
   raising it later is a one-line change, lowering it after release is not.
2. **R2 account and domain.** Stage 3 needs a Cloudflare account and,
   preferably, a domain to serve artifacts from. Neither exists yet.
3. **Whether `~/Music/Ableton` raises a privacy prompt.** Answered by stage 1's
   clean-account run, at no extra cost.
