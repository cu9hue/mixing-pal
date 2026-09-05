import { BrandMark } from "./BrandMark";

/**
 * Three elements and nothing else: the mark, is it connected, and a way
 * to close.
 *
 * The connection is a dot with the word "Live" beside it. A dot alone
 * asked her to guess what it measured; the word says which connection,
 * the colour says whether it holds, and the title says both in a sentence.
 * The failure banner under the header carries the words on failure.
 *
 * No tempo, no key, no track count. Live shows all three, larger and more
 * accurately, and mirroring them would make this a worse copy of a window
 * that is already open. They live in the disclosure below, where the job
 * is proof rather than information.
 */
export function Header({ connected, onCollapse }: { connected: boolean; onCollapse: () => void }) {
  return (
    <div className="card__header">
      <BrandMark />
      <span
        className={`card__label card__live${connected ? "" : " card__live--error"}`}
        title={connected ? "Connected to Live" : "Not connected to Live"}
      >
        <span className={`card__dot ${connected ? "card__dot--ok" : "card__dot--error"}`} />
        Live
      </span>
      <button className="card__chevron" onClick={onCollapse} title="Collapse">
        ⌄
      </button>
    </div>
  );
}
