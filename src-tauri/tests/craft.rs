//! Craft scenarios: does the advice have the shape the craft ontology asks
//! for? See docs/superpowers/specs/2026-09-02-craft-ontology-design.md.
//!
//! Not run by `cargo test`: the target needs `--features evals`. The first
//! test below costs nothing and needs no credentials: it checks that the
//! fake Live answers every read the craft fixture supports, so a red craft
//! scenario is about the prompt and never about a missing read. Every other
//! test asks a real model, then a judge model, and costs money:
//!
//!   MIXINGPAL_EVAL_BASE_URL=... MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
//!     [MIXINGPAL_JUDGE_MODEL=...] \
//!     cargo test --features evals --test craft -- --test-threads=1
//!
//! Unlike `evals.rs`, these assert on prose, through a judge. Wording is not
//! stable across runs, so each scenario passes on a majority of three.

mod common;

use mixing_pal_lib::eval_api::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn fixture() -> Value {
    common::load("craft-set.json")
}

async fn tools() -> ToolContext {
    let f = fixture();
    ToolContext {
        coalescer: common::mirror(&f),
        query: Arc::new(Mutex::new(Some(common::fake_live(f).await))),
    }
}

async fn read(ctx: &ToolContext, name: &str, args: Value) -> Value {
    serde_json::to_value(execute(ctx, name, &args).await).unwrap()
}

#[tokio::test]
async fn the_fake_live_serves_the_craft_fixture_in_full() {
    // The honesty fixture is deliberately broken. This one must not be: a
    // craft scenario that fails because a read came back missing is not a
    // finding about the prompt.
    let ctx = tools().await;
    let reads = [
        ("get_track_detail", json!({ "track": 0 })),
        ("get_clips", json!({})),
        ("get_clip_notes", json!({ "track": 0, "clip": 0 })),
        ("get_arrangement", json!({})),
        ("get_arrangement_notes", json!({ "track": 0, "index": 0 })),
        ("get_device_chains", json!({})),
        ("get_rack_contents", json!({ "track": 1, "path": [0] })),
        ("get_device_params", json!({ "track": 3, "path": [0] })),
    ];
    for (name, args) in reads {
        let r = read(&ctx, name, args.clone()).await;
        assert!(r["missing_reason"].is_null(), "{name} {args}: {r}");
        assert!(!r["value"].is_null(), "{name} {args}: {r}");
    }

    let detail = read(&ctx, "get_track_detail", json!({ "track": 0 })).await.to_string();
    assert!(detail.contains("-6.0 dB"), "the mirror should carry the fader: {detail}");

    let rack = read(&ctx, "get_rack_contents", json!({ "track": 1, "path": [0] })).await.to_string();
    for chain in ["Kick", "Clap", "Hats"] {
        assert!(rack.contains(chain), "{chain} missing from {rack}");
    }

    let comp = read(&ctx, "get_device_params", json!({ "track": 3, "path": [0] })).await.to_string();
    assert!(comp.contains("Threshold") && comp.contains("-18.0 dB"), "{comp}");
}
