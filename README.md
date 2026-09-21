# Mixing Pal

A desktop copilot for producers working in Ableton Live. It watches the set you
have open and answers questions about it in plain language, so you can ask what
is fighting what instead of soloing twelve tracks to find out.

It is a macOS app, built and verified against Ableton Live 12. Earlier versions
of Live are untested. The app's macOS floor is 11.0, which is Live 12's own.

## How it fits together

Two artifacts, deployed separately, that have to agree with each other.

**The app** is Tauri 2: a Rust core with a React frontend. It holds the model
client, the OSC socket, and the window machinery.

**The connector** is a Python Remote Script at `remote-script/MixingPal/`. Its
`abletonosc/` and `pythonosc/` directories are AbletonOSC, vendored unmodified at
a pinned commit — see `remote-script/MixingPal/UPSTREAM`. The `mixingpal/` package
beside them is ours. Live loads the whole thing at startup and it talks to the app
over OSC. The app ships the connector inside its own bundle and installs it into
your Ableton User Library on first run; you never touch a terminal.

The two are versioned independently:

| Number | Where | Changes when |
| --- | --- | --- |
| App version | `src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml` | every release |
| Wire version | `shared/wire-version.json`, `remote-script/MixingPal/mixingpal/version.py` | the OSC contract changes — message shapes, argument counts |

Both are guarded by tests. The app version has to match across all three
manifests. The wire version has to match across the JSON and the Python, and the
app polls the running script at connect so it can say "your connector is stale"
instead of quietly misreading a reply.

## Development

You need a Rust toolchain, Node, and Ableton Live.

```bash
npm install
npm run tauri dev
```

In development the app installs the connector from this repository rather than
from its own bundle. Live loads the *installed* copy, not the repository one, so
an edit under `remote-script/` reaches Live only after you reinstall the connector
from setup and then restart Live. `sync_dir` mirrors the repository copy over the
installed one, leaving `logs/` alone because a running Live session owns it.

### Tests

```bash
npx vitest run              # frontend
cd src-tauri && cargo test  # Rust
npm run build               # tsc + vite, catches type errors
```

Several tests are tripwires rather than unit tests: they read a config file or a
source file and assert that two things which have no type-level relationship
still agree. They exist because the failures they catch are silent — an app that
ships without its connector, or a version that drifts in one manifest of three.
When one fails, read its message; it names the failure mode.

### Pilot proxy deployment

Run `cd proxy && npm run deploy -- help` for the staging and production
procedure. Before enabling either stage, create account-wide Cloudflare budget
alerts at $10 and $25 under **Manage Account → Billing → Billable Usage**. These
alerts send warnings; they do not cap usage. Set
`MIXINGPAL_BUDGET_ALERTS_VERIFIED=yes` only after both alerts are active.

The deploy command applies the D1 capture budget and the R2 lifecycle rules
before it publishes the Worker. It leaves inference disabled until the separate
enable command passes all release acknowledgments.

## Releasing a new version

There is no release automation yet. This is the manual procedure.

**1. Decide whether the wire contract changed.** If the Remote Script's message
shapes changed, bump `WIRE_VERSION` in `remote-script/MixingPal/mixingpal/version.py`
and the matching number in `shared/wire-version.json`. Otherwise leave it alone —
bumping it needlessly forces every user through a connector reinstall.

**2. Bump the app version** in all three manifests. `npx vitest run` fails if you
miss one.

**3. Test, then build.**

```bash
npx vitest run && npm run build && (cd src-tauri && cargo test)
npm run build:mac
```

`build:mac` must run in a logged-in graphical session. Tauri's DMG step drives
Finder through `osascript`; a detached or headless run compiles both
architectures and then fails at the last step.

**4. Check the artifact.**

```bash
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Mixing Pal.app"
lipo -archs "$APP/Contents/MacOS/"*                                  # x86_64 arm64
/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$APP/Contents/Info.plist"   # 11.0
ls "$APP/Contents/Resources/MixingPal/mixingpal/version.py"          # connector is aboard
```

**5. Hand the `.dmg` over through `/Users/Shared` or a USB stick.** Not AirDrop,
not a download link. The bundle is not signed, so a copy that arrives carrying
macOS's quarantine attribute is refused with "damaged and can't be opened" — a
message that does not reliably offer an **Open Anyway** button. See
`docs/opening-an-unsigned-build.md`.

**6. Install.** Quit Mixing Pal, then drag the new app into `/Applications`,
replacing the old one.

**7. Start Live before relaunching Mixing Pal.** This step is easy to skip and
the reason is not obvious. The app decides the connector is stale only when the
running script reports a different wire version; with Live closed it has no
answer, assumes the connector is current, and does not prompt for the reinstall
it needs.

**8. If setup reopens on the install step, reinstall the connector — then
restart Live.** Live reads Remote Scripts only at startup, so until you restart
it, the old script is still the one running.

Steps 7 and 8 apply only when the wire version changed. They will survive release
automation: an app update carries a new connector inside its bundle, but the copy
in the User Library changes only when the installer runs, and Live still has to
be restarted.

## Verifying against real Live

Nothing in this repository proves the app works with Live. Before a release a
person opens a real set, checks that the control surface is listed, that deltas
arrive, and that a fresh machine can install from the `.dmg`, and records what
they saw in the PR that cuts the release.

## Where the design lives

`docs/` holds two files: `ROADMAP.md`, what ships next and why, and
`opening-an-unsigned-build.md`. The design documents and implementation plans
that used to sit under `docs/superpowers/` were removed on 2026-09-08; they are
in git history before that date, and the code comments that cite one by date
mean that history.
