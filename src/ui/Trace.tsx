import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Trace.css";

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
    <div className="trace__step">
      <div className="trace__step-head">
        <span>
          <b>{step.kind === "model" ? "model" : `tool: ${step.name}`}</b> · {formatTime(step.at)}
        </span>
        <span>{step.duration_ms} ms</span>
      </div>
      {flags && (
        <div className={`trace__flags${flags.missing_reason ? " trace__flags--missing" : ""}`}>
          fresh: {String(flags.fresh)} · fresh_as_of:{" "}
          {typeof flags.fresh_as_of === "number" ? formatTime(flags.fresh_as_of) : "—"}
          {flags.missing_reason ? ` · missing_reason: ${String(flags.missing_reason)}` : ""}
        </div>
      )}
      <pre className="trace__body">
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
    <div className="trace">
      <button className="trace__button" onClick={toggle}>
        {open ? "Hide trace" : "Show trace"}
      </button>
      {open && (
        <div className="trace__panel">
          <div className="trace__hint">
            A trace contains track names and MIDI from your project. Only copy or share it somewhere you trust.
          </div>
          <div className="trace__toolbar">
            <button className="trace__button" onClick={refresh}>
              Refresh
            </button>
            <button className="trace__button" onClick={clear}>
              Clear
            </button>
            <button className="trace__button" onClick={copyAll} disabled={steps.length === 0}>
              {copied ? "Copied" : "Copy trace"}
            </button>
          </div>
          {steps.length === 0 ? (
            <div className="trace__empty">No steps recorded yet.</div>
          ) : (
            [...steps].reverse().map((s, i) => <StepView key={i} step={s} />)
          )}
        </div>
      )}
    </div>
  );
}
