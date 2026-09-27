import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./Card";
import { emptySet } from "../live/apply";
import { AccountState } from "../model/account";

const signedOutAccount: AccountState = {
  view: { access: "signed_out", capture: false },
  error: null,
  refresh: async () => {},
  change: () => {},
  observe: () => () => {},
};

describe("a signed-out card", () => {
  it("shows sign-in without Live setup or chat", () => {
    const html = renderToStaticMarkup(
      <Card
        account={signedOutAccount}
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
    expect(html).toContain(">Your music production assistant.</h2>");
    expect(html).toContain("Sign into your MixingPal account");
    expect(html).toContain('placeholder="Enter the email from your invitation"');
    expect(html).not.toContain("Use the email on your invitation.");
    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain("Mixing Pal account");
    expect(html).not.toContain("How your data is handled");
    expect(html).not.toContain("Not connected");
    expect(html).not.toContain("Ask about the set");
    expect(html).not.toContain(">Settings</button>");
  });
});

it.each(["active", "expired", "revoked"] as const)("keeps the %s account panel out of the chat view", (access) => {
  const html = renderToStaticMarkup(<Card
    account={{ ...signedOutAccount, view: { access, capture: false, can_ask: false, service_paused: true, email: "producer@example.com" } }}
    state={emptySet()} lastSeen={null} connected={false} nudge={null}
    onDismissNudge={() => {}} onTurnRunningChange={() => {}} onAnswer={() => {}}
    onCollapse={() => {}} onShowSetup={() => {}} settingsOpen={false} onCloseSettings={() => {}}
  />);
  expect(html).not.toContain("producer@example.com");
  expect(html).not.toContain("Sign out");
  expect(html).not.toContain("Delete account");
  expect(html).not.toContain('class="account');
});
