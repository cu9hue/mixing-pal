import { Recap } from "./recap";
import "./RecapView.css";

/** Last time on this set, above the folded thread. Each line stays one line; an ellipsis cuts the rest. */
export function RecapView({ recap, onDismiss }: { recap: Recap; onDismiss: () => void }) {
  const lines: [string, string][] = [
    ["You asked", recap.asked],
    ...recap.rated.map((r): [string, string] => [r.outcome === "kept" ? "Kept" : "Undid", r.heard === "" ? r.move : `${r.move} · “${r.heard}”`]),
    ...recap.decided.map((text): [string, string] => ["Decided", text]),
  ];
  return (
    <section className="recap" aria-labelledby="recap-title">
      <div className="recap__head">
        <h2 id="recap-title" className="recap__title">Last time</h2>
        <span className="recap__when">· {recap.when}</span>
        <button className="recap__dismiss" aria-label="Dismiss the recap" onClick={onDismiss}>×</button>
      </div>
      <dl className="recap__lines">
        {lines.map(([label, text], i) => (
          <div key={i} className="recap__line">
            <dt>{label}</dt>
            <dd title={text}>{text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
