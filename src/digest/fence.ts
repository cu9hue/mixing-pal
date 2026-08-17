// The TypeScript half of the fence. See src-tauri/src/tools/fence.rs for why
// this exists; the two must agree byte for byte, which
// shared/fence-vectors.json pins.
export const MAX_FENCED_LEN = 120;

export function fence(raw: string): string {
  const cleaned = Array.from(raw)
    .filter((c) => c !== "«" && c !== "»")
    // \p{Cc} is the Unicode Cc category, which is exactly what Rust's
    // char::is_control() tests. \p{Zl}/\p{Zp} (U+2028/U+2029) are added
    // alongside it: they render as real line breaks in many contexts but
    // aren't Cc, so a crafted name carrying one could still forge a new
    // message turn without this.
    .map((c) => (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(c) ? " " : c))
    .slice(0, MAX_FENCED_LEN)
    .join("");
  return `«${cleaned}»`;
}
