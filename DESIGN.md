# Onboarding design

## Personality

- Quiet, not sparse
- Direct, not demanding
- Familiar to Ableton users, not a copy of Ableton
- Focused, not empty

A first-time producer should see one clear next action, not a diagnostic dashboard.

## Reference set

| Reference | What we take | What we leave |
|---|---|---|
| Existing Mixing Pal card | its compact floating geometry | stacked independent panels |
| Ableton Live | its task-first, production-tool hierarchy | dense information display |
| Mixing Pal landing page | pink identity ink, acid-green actions and focus, pink-tinted black surfaces | its print texture and poster-scale type |
| Notion sign-in screen (user reference) | one-line pitch, centered account instruction, full-width primary action | its white surface, blue CTA, and oversized marketing headline |

Anti-references: sign-in screens that present product setup, account policy, and the primary app at once.

## Tokens

The existing CSS variables remain the source of truth. This React app does not use Tailwind.

```css
:root {
  --surface: #0d070b;
  --surface-raised: #191116;
  --surface-sunken: #080508;
  --surface-backdrop: rgba(13, 7, 11, 0.7);
  --border: #4e3c47;
  --border-strong: #68505e;
  --text: #eee5ea;
  --text-secondary: #d8cbd2;
  --text-muted: #ab9da5;
  --text-faint: #968991;
  --brand: #fd24cd;
  --brand-hover: #c8009f;
  --brand-core: #83f700;
  --accent: #83f700;
  --accent-hover: #67d000;
  --ok: #83f700;
  --error: #ff2f3a;
  --radius-card: 12px;
  --radius-control: 8px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --text-xs: 0.6875rem;
  --text-sm: 0.75rem;
  --text-md: 0.8125rem;
  --text-lg: 0.875rem;
  --text-xl: 0.9375rem;
  --space-0-5: 2px;
  --space-1: 4px;
  --space-1-5: 6px;
  --space-2: 8px;
  --space-2-5: 10px;
  --space-3: 12px;
  --space-3-5: 14px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --touch-target: 44px;
}
```

## Interaction rules

- The only entry sequence is sign in, connect Ableton, choose a plan, answer the sharing question, optionally name the Live set's goal in the card, then chat. The plan comes after the connected screen, so a new user sees the app read their set before Checkout asks for a card. One action starts chatting with or without a goal; each set keeps that choice with its conversation.
- Signed-out views omit Live status, chat, goals, notes, and data summaries.
- Sign-in centers “A mentor for the track you're writing.” above “Sign in with your email.” Its field label stays left aligned, and the placeholder reads “Enter your email”. `--accent` provides the acid-green action and focus ring.
- Only when the proxy reports invite-only sign-up does the subtitle read “Sign in with the email your invite came to.”, with the invitation-email placeholder. A failed read keeps the open wording.
- Below the email field, an unchecked box reads “I agree to the Terms and the Privacy Policy.”, with each name a quiet link that opens its page on mixingpal.com. It is the only policy element on sign-in. Continue stays off until the box is ticked. The plan step shows the same box only when the account has not agreed to the current Terms.
- Prompt ideas are 44px minimum-height buttons. They fill the composer but never send a request.
- An answer's feedback stays out of the way: nothing sits under a fresh answer, a rated one gets one muted result line, and a ⋯ menu right after each question holds “Change how it went” and “Report a problem”. Reporting is never only in a menu: the footer's one line always reads “AI can make mistakes. Report a problem”, which reports the newest answer when there is one, and a failed answer shows “Report this” right under it. The check-in “How did the last move go?” appears flat in the footer above the composer only when the producer comes back, never as a card, and never blocks the composer.
- After a break of 3 hours or more, a set reopens on a flat “Last time” recap: the producer's last question, the newest three rated moves with what they heard, and the newest two decided notes. It stands in for the earlier answers, which unfold from “Show N earlier answers”. It never repeats the move the check-in asks about. × hides it until the next break. A shorter break shows the full thread.
- `:focus-visible` uses the existing 2px accent outline. Buttons retain default, hover, active, disabled, error, and success states where applicable.
- Motion is limited to 120ms colour transitions and respects existing reduced-motion rules.

- Settings has a fixed title and Done footer around one scrollable body. Its controls use the same neutral outline; download and restart use `--accent`. Update details show the version only.
- An available update opens a compact dialog on the chat screen. “Not now”, the close button, and Escape dismiss it for that version during the app session. Review opens Settings; downloading and restarting remain separate actions. The dialog never opens over onboarding or the collapsed pill.
- Onboarding progress sits 32px below the window edge, aligned with the 40px content inset. Content starts 24px below it.

## Explicit negatives

- No gradients, glass surfaces, nested cards, or decorative illustration.
- No more than one primary task per onboarding screen.
- Do not use a status banner as onboarding content.
