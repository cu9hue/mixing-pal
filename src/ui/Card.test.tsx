import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./Card";
import { emptySet } from "../live/apply";
import { AccountState, AccountView } from "../model/account";
import { ExperienceState } from "../model/experience";

const signedOutAccount: AccountState = {
  view: { access: "signed_out", capture: false },
  error: null,
  refresh: async () => {},
  change: () => {},
  observe: () => () => {},
};

const experience: ExperienceState = { experience: "finishes_tracks", error: null, choose: async () => {} };

describe("a signed-out card", () => {
  it("shows sign-in without Live setup or chat", () => {
    const html = renderToStaticMarkup(
      <Card
        account={signedOutAccount}
        experience={experience}
        state={emptySet()}
        lastSeen={null}
        connected={false}
        nudge={null}
        onDismissNudge={() => {}}
        onTurnRunningChange={() => {}}
        onAnswer={() => {}}
        onCollapse={() => {}}
        onShowSetup={() => {}}
        settingsOpen={false}
        onCloseSettings={() => {}}
      />,
    );

    expect(html).toContain("<h2 id=");
    expect(html).toContain(">A mentor for the track you&#x27;re writing.</h2>");
    expect(html).toContain("Sign in with your email.");
    expect(html).toContain('placeholder="Enter your email"');
    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain("Mixing Pal account");
    expect(html).not.toContain("How your data is handled");
    expect(html).not.toContain("Not connected");
    expect(html).not.toContain("Ask about the set");
    expect(html).not.toContain(">Settings</button>");
  });
});

const cardFor = (view: AccountView) => renderToStaticMarkup(<Card
  account={{ ...signedOutAccount, view }}
  experience={experience} state={emptySet()} lastSeen={null} connected={false} nudge={null}
  onDismissNudge={() => {}} onTurnRunningChange={() => {}} onAnswer={() => {}}
  onCollapse={() => {}} onShowSetup={() => {}} settingsOpen={false} onCloseSettings={() => {}}
/>);

it.each(["active", "expired"] as const)("keeps the %s account panel out of the chat view", (access) => {
  const html = cardFor({ access, capture: false, can_ask: false, service_paused: true, email: "producer@example.com" });
  expect(html).not.toContain("producer@example.com");
  expect(html).not.toContain("Sign out");
  expect(html).not.toContain("Delete account");
  expect(html).not.toContain('class="account');
  expect(html).toContain('class="card__session"');
});

it.each([
  ["plan_required", "Start 7-day free trial"],
  ["revoked", "Your access was revoked. Contact Mixing Pal."],
] as const)("shows a %s member the account panel instead of chat", (access, line) => {
  const html = cardFor({ access, capture: false, trial_available: true, email: "producer@example.com" });
  expect(html).toContain("card__account--solo");
  expect(html).toContain(line);
  expect(html).toContain(">Sign out</button>");
  expect(html).toContain(">Delete account…</button>");
  expect(html).toContain("card__session--hidden");
  expect(html).not.toContain("Not connected to Live");
});
