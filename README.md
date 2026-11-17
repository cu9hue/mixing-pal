# Mixing Pal

A desktop copilot for producers working in Ableton Live. It reads the set the
producer has open and answers questions about it in plain language. The
producer can ask what is fighting what instead of soloing twelve tracks to
find out.

It is a macOS app, built and verified against Ableton Live 12.

**Status:** no longer actively developed. The hosted service is still up, and
the signed app is at [mixingpal.com](https://mixingpal.com).

## What the model sees

The app keeps a mirror of the open set and sends the model a compact summary
with every question:

```text
SET  132 BPM · A Minor · stopped
SECTIONS (beats; bars assume 4/4)  «Intro» 0 (bar 1), «Drop» 64 (bar 17)
GOAL  dark garage, 2am

TRACKS  (4)
 0 «Pad» -6.0 dB — selected
 1 «Drums» -3.0 dB
 2 «Vox» -8.0 dB
 3 «Bass» -5.0 dB
```

When the model needs more, it calls one of ten read tools: track detail, the
mixer, clips, clip notes, the arrangement, arrangement notes, device chains,
device parameters, rack contents, and samples. The sample tool decodes the
audio file on the producer's machine and sends the model measurements of
level, pitch, spectrum and stereo width.

## How it fits together

- **The app** (`src/`, `src-tauri/`) is Tauri 2: a Rust core with a React
  frontend. It holds the set mirror, the OSC socket, the tools and the model
  client.
- **The connector** (`remote-script/`) is a Python Remote Script that Live
  loads at startup. It talks to the app over OSC. It builds on
  [AbletonOSC](https://github.com/ideoforms/AbletonOSC), vendored unmodified at
  a pinned commit. The app installs the connector on first run.
- **The proxy** (`proxy/`) is a Cloudflare Worker. It holds the model provider
  key, signs producers in with an email code, charges for plans through
  Stripe, and serves app updates.

The app and the connector agree on a wire version in
`shared/wire-version.json`. The app checks it at connect, so it can say "your
connector is stale" instead of misreading a reply.

## Run it from source

You need a Rust toolchain, Node 22, Python 3 and Ableton Live 12.

```bash
npm install
npm run tauri dev -- --features direct-provider
```

The `direct-provider` feature skips sign-in. Open the settings, and under
**Model settings** enter a base URL, a model name and an API key. The base URL
defaults to OpenRouter. The model has to support tool calls.

## Tests

```bash
npm test                    # frontend and connector
cd src-tauri && cargo test  # Rust
cd proxy && npm test        # the Worker
```

Two eval suites, `src-tauri/tests/evals.rs` and `src-tauri/tests/craft.rs`,
run the real prompt and tools against a real model and a fake Live. They cost
money, so a plain `cargo test` skips them. The header comment in each file
says how to run it.

## More

- `docs/ROADMAP.md`: what shipped, what did not, and why.
- `.github/workflows/`: the signed release and the pilot and stable update
  channels.
- `cd proxy && npm run deploy -- help`: the proxy's deploy procedure.

## License

MIT. See `LICENSE`. The vendored AbletonOSC code is also MIT. Its license is
at `remote-script/MixingPal/LICENSE-AbletonOSC.md`.
