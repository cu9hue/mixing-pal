import { useEffect, useRef, useState } from "react";
import { UpdateView } from "../model/updates";
import "./UpdateNotice.css";

export function UpdateNotice({ view, visible, onReview }: {
  view: UpdateView;
  visible: boolean;
  onReview: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const later = useRef<HTMLButtonElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  const show = visible && Boolean(view.version) && view.version !== dismissed
    && (view.phase === "available" || view.phase === "ready");

  useEffect(() => {
    if (!show) return;
    const element = dialog.current!;
    element.showModal();
    later.current?.focus();
    return () => element.close();
  }, [show]);

  if (!show) return null;
  const dismiss = () => {
    dialog.current?.close();
    setDismissed(view.version);
  };
  return <dialog ref={dialog} className="update-notice" aria-labelledby="update-notice-title"
    aria-describedby="update-notice-detail" data-tauri-drag-region="false"
    onCancel={(event) => { event.preventDefault(); dismiss(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      if (event.key !== "Tab") return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }}>
    <div className="update-notice__header">
      <h2 id="update-notice-title">Mixing Pal update</h2>
      <button className="update-notice__close" aria-label="Close update notification" onClick={dismiss}>×</button>
    </div>
    <p id="update-notice-detail">Version {view.version} {view.phase === "ready" ? "is ready to install." : "is available."}</p>
    <p className="update-notice__hint">Keep working and update later in Settings.</p>
    <div className="update-notice__actions">
      <button className="advanced__button advanced__button--primary" onClick={() => { dismiss(); onReview(); }}>Review update</button>
      <button className="advanced__button" ref={later} onClick={dismiss}>Not now</button>
    </div>
  </dialog>;
}
