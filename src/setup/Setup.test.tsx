import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Setup } from "./Setup";
import { SetupStep } from "./step";
import { AccountState } from "../model/account";
import { ExperienceState } from "../model/experience";

type Access = "signed_out" | "invitation_required" | "plan_required" | "active";
const account = (access: Access): AccountState => ({
  view: { access, capture: false, email: "producer@example.com", trial_available: true },
  error: null, refresh: async () => {}, change: () => {}, observe: () => () => {},
});
const experience: ExperienceState = { experience: null, error: null, choose: async () => {} };

function render(step: SetupStep, opts: { access?: Access; experience?: ExperienceState } = {}) {
  return renderToStaticMarkup(
    <Setup account={account(opts.access ?? "active")} experience={opts.experience ?? experience} step={step}
      folder="MixingPal" trackCount={3} trackNames={["Pad", "Drums", "Vox"]} onFactsChanged={() => {}} />,
  );
}

describe("setup", () => {
  it.each([
    ["account", "Step 1 of 4"], ["install", "Step 2 of 4"], ["open_live", "Step 2 of 4"],
    ["control_surface", "Step 2 of 4"], ["connected", "Step 3 of 4"], ["plan", "Step 4 of 4"],
  ] as const)("labels %s as %s", (step, label) => {
    const access = step === "account" ? "signed_out" : step === "plan" ? "plan_required" : "active";
    expect(render(step, { access })).toContain(`>${label}</div>`);
  });

  it("shows the plan choice with no way to delete the account from first-run setup", () => {
    const html = render("plan", { access: "plan_required" });
    expect(html).toContain("Choose your plan");
    expect(html).toContain("Start 7-day free trial");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Delete account");
  });

  it("counts the invite code as part of step 1", () => {
    expect(render("account", { access: "invitation_required" })).toContain(">Step 1 of 4</div>");
  });

  it("draws four ticks", () => {
    expect(render("plan", { access: "plan_required" }).match(/class="setup__tick/g)).toHaveLength(4);
  });

  it("asks how the producer works on the connected screen, with no separate Got it", () => {
    const html = render("connected");
    expect(html).toContain("I can see <b>3 tracks</b>: Pad, Drums, Vox…");
    expect(html).toContain("I read your settings: devices, faders, routing and notes. I can&#x27;t hear your audio");
    expect(html).toContain("How do you work in Live?");
    for (const label of ["New to Live", "I finish tracks", "I mix for other people"]) expect(html).toContain(label);
    expect(html).not.toContain("Got it");
  });

  it("keeps the producer on the connected screen with the error when saving the level fails", () => {
    const html = render("connected", { experience: { ...experience, error: "Couldn't save that." } });
    expect(html).toContain("Couldn&#x27;t save that.");
    expect(html).toContain("How do you work in Live?");
  });

  it("uses the new copy on every screen it changed", () => {
    expect(render("account", { access: "signed_out" })).toContain("A mentor for the track you&#x27;re writing.");
    expect(render("account", { access: "signed_out" })).toContain("Sign in with your email.");
    expect(render("account", { access: "invitation_required" })).toContain("Enter the invite code from your email.");
    expect(render("install")).toContain("Add Mixing Pal to Live.");
    expect(render("install")).toContain(">Install the connector</button>");
    expect(render("control_surface")).toContain("Waiting for Live to connect…");
    expect(render("control_surface")).toContain("Is MixingPal missing from the list? Quit Live and open it again.");
  });
});
