// The TypeScript half of the fence. See src-tauri/src/tools/fence.rs for why
// this exists; the two must agree byte for byte, which
// shared/fence-vectors.json pins.
export const MAX_FENCED_LEN = 120;

export function fence(raw: string): string {
  const cleaned = Array.from(raw)
    .filter((c) => c !== "«" && c !== "»")
    // \p{Cc} is the Unicode Cc category, which is exactly what Rust's
    // char::is_control() tests.
    .map((c) => (/\p{Cc}/u.test(c) ? " " : c))
    .slice(0, MAX_FENCED_LEN)
    .join("");
  return `«${cleaned}»`;
}
