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
}
```

## Interaction rules

- The only entry sequence is sign in, connect Ableton, name the goal, then chat.
- Signed-out views omit Live status, chat, goals, notes, and data summaries.
- Sign-in centers “Your music production assistant.” above “Sign into your MixingPal account”. Its field label stays left aligned. The exact invitation-email placeholder remains in the field. `--accent` provides the acid-green action and focus ring.
- Prompt ideas are 44px minimum-height buttons. They fill the composer but never send a request.
- `:focus-visible` uses the existing 2px accent outline. Buttons retain default, hover, active, disabled, error, and success states where applicable.
- Motion is limited to 120ms colour transitions and respects existing reduced-motion rules.

## Explicit negatives

- No gradients, glass surfaces, nested cards, or decorative illustration.
- No more than one primary task per onboarding screen.
- Do not use a status banner as onboarding content.
