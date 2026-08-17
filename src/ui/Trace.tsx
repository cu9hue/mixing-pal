import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/trace.rs's TraceStep. This is the whole IPC contract
// for this pane -- the backend already truncated and redacted anything
// large or sensitive before it ever reaches here.
export type TraceStep =
  | { kind: "model"; at: number; request: unknown; outcome: unknown; duration_ms: number }
  | { kind: "tool"; at: number; name: string; args: unknown; result: unknown; duration_ms: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/**
 * Pulls `fresh`/`fresh_as_of`/`missing_reason` out of a tool step's result
 * so they read at a glance -- those are the fields that explain a
 * disappointing answer. `undefined` when the result was itself replaced by
 * a truncation marker (no ToolResult shape to read from), not when the
 * fields are merely absent.
 */
function toolResultFlags(result: unknown): { fresh: unknown; fresh_as_of: unknown; missing_reason: unknown } | null {
  if (!isRecord(result) || !("fresh" in result)) return null;
  return {
    fresh: result.fresh,
    fresh_as_of: result.fresh_as_of,
    missing_reason: result.missing_reason,
  };
}

function StepView({ step }: { step: TraceStep }) {
  const flags = step.kind === "tool" ? toolResultFlags(step.result) : null;
  const body =
    step.kind === "model"
      ? { request: step.request, outcome: step.outcome }
      : { args: step.args, result: step.result };

  return (
    <div style={{ border: "1px solid #444", borderRadius: 4, padding: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.8 }}>
        <span>
          <b>{step.kind === "model" ? "model" : `tool: ${step.name}`}</b> · {formatTime(step.at)}
        </span>
        <span>{step.duration_ms} ms</span>
      </div>
      {flags && (
        <div
          style={{
            fontSize: 12,
            margin: "4px 0",
            color: flags.missing_reason ? "#e08a8a" : "#8ac98a",
          }}
        >
          fresh: {String(flags.fresh)} · fresh_as_of:{" "}
          {typeof flags.fresh_as_of === "number" ? formatTime(flags.fresh_as_of) : "—"}
          {flags.missing_reason ? ` · missing_reason: ${String(flags.missing_reason)}` : ""}
        </div>
      )}
      <pre
        style={{
          maxHeight: 220,
          overflow: "auto",
          background: "#1a1a1a",
          color: "#ddd",
          padding: 6,
          margin: 0,
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {JSON.stringify(body, null, 2)}
      </pre>
    </div>
  );
}

/**
 * Collapsed by default. Answers "why did the copilot say that?" by showing
 * exactly what the model was sent and what its tools returned -- see
 * src-tauri/src/trace.rs's module doc for the motivating case.
 *
 * Fetches on open and on demand (Refresh); never polls on a timer.
 */
export function Trace() {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    const fetched = await invoke<TraceStep[]>("trace");
    setSteps(fetched);
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        await refresh();
      } catch (err) {
        console.error("failed to fetch trace", err);
      }
    }
  }

  async function clear() {
    try {
      await invoke("clear_trace");
      setSteps([]);
    } catch (err) {
      console.error("failed to clear trace", err);
    }
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(steps, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("failed to copy trace", err);
    }
  }

  return (
    <div style={{ borderTop: "1px solid #444" }}>
      <button onClick={toggle} style={{ margin: 10 }}>
        {open ? "Hide trace" : "Show trace"}
      </button>
      {open && (
        <div style={{ padding: "0 10px 10px" }}>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
            A trace contains track names and MIDI from your project. Only copy or share it somewhere you trust.
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <button onClick={refresh}>Refresh</button>
            <button onClick={clear}>Clear</button>
            <button onClick={copyAll} disabled={steps.length === 0}>
              {copied ? "Copied" : "Copy trace"}
            </button>
          </div>
          {steps.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 12 }}>No steps recorded yet.</div>
          ) : (
            [...steps].reverse().map((s, i) => <StepView key={i} step={s} />)
          )}
        </div>
      )}
    </div>
  );
}
