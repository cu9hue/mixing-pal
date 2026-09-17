import { useId, useState } from "react";
import "./SharingConsent.css";

const DETAIL =
  "Optional. Save your questions, relevant set context, tool reads, raw answers and outcomes for human review for 30 days. Outcomes from advice given before you enabled sharing stay on this laptop. You can stop future sharing or delete a shared turn. This does not permit model training.";

export function SharingConsent({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <div className="sharing-consent">
      <div className="sharing-consent__row">
        <label className="sharing-consent__label" htmlFor={`${id}-input`}>
          <input
            id={`${id}-input`}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>Share advice and outcomes to help improve Mixing Pal</span>
        </label>
        <button
          className="sharing-consent__info"
          type="button"
          aria-label="How sharing works"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
        >
          ?
        </button>
      </div>
      {open && (
        <div id={`${id}-detail`} className="sharing-consent__tooltip" role="tooltip">
          {DETAIL}
        </div>
      )}
    </div>
  );
}
