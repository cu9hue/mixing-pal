import { useEffect, useRef, useState } from "react";

export function AnswerMenu({ canChange, disabled, onChangeOutcome, onReport }: {
  canChange: boolean;
  disabled: boolean;
  onChangeOutcome: () => void;
  onReport?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  if (!canChange && !onReport) return null;
  // On the root, so Escape works whether focus is on the button or in the list.
  return <div className="answer-menu" ref={root} data-tauri-drag-region="false"
    onKeyDown={(e) => { if (open && e.key === "Escape") { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
    <button ref={button} type="button" className="answer-menu__button" aria-label="More actions"
      aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>⋯</button>
    {open && <div className="answer-menu__list" role="menu">
      {canChange && <button type="button" role="menuitem" onClick={() => { setOpen(false); onChangeOutcome(); }}>
        Change how it went</button>}
      {/* The report sheet returns focus to whatever had it when it opened. */}
      {onReport && <button type="button" role="menuitem" onClick={() => { setOpen(false); button.current?.focus(); onReport(); }}>
        Report a problem</button>}
    </div>}
  </div>;
}
