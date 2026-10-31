import { invoke } from "@tauri-apps/api/core";

/** The box that stands for agreeing to the Terms and the Privacy Policy. Each link opens its page on mixingpal.com. */
export function TermsAgreement({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const open = (page: "terms" | "privacy") => { void invoke("open_page", { page }); };
  return (
    <label className="account__terms">
      {/* Named outright: computed from the text, the links' boundaries put a space before the full stop. */}
      <input type="checkbox" aria-label="I agree to the Terms and the Privacy Policy." checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>I agree to the <button className="account__link" type="button" onClick={() => open("terms")}>Terms</button>
        {" "}and the <button className="account__link" type="button" onClick={() => open("privacy")}>Privacy Policy</button>.</span>
    </label>
  );
}
