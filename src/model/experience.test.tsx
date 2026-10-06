// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { createBusyState } from "./updates";
import { useExperience } from "./experience";
import { ConnectedScreen } from "../setup/screens";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });

function Screen({ busy }: { busy: ReturnType<typeof createBusyState> }) {
  const experience = useExperience(busy);
  return <>
    <ConnectedScreen trackCount={0} trackNames={[]} experience={experience} />
    <output>{String(experience.experience)}</output>
  </>;
}

it("saves the choice under the name Rust deserialises", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  render(<Screen busy={createBusyState()} />);
  await screen.findByText("null");
  fireEvent.click(screen.getByRole("button", { name: /New to Live/ }));
  await screen.findByText("new_to_live");
  expect(invoke).toHaveBeenCalledWith("set_experience", { experience: "new_to_live" });
});

it("does not save while an update installs", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  const busy = createBusyState();
  busy.install = true;
  render(<Screen busy={busy} />);
  await screen.findByText("null");
  fireEvent.click(screen.getByRole("button", { name: /I mix for other people/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke).not.toHaveBeenCalledWith("set_experience", expect.anything());
});

it("keeps a choice made before the stored level arrives", async () => {
  let answerRead!: (value: null) => void;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "get_experience") return new Promise((resolve) => { answerRead = resolve; });
    return null;
  });
  render(<Screen busy={createBusyState()} />);
  fireEvent.click(screen.getByRole("button", { name: /New to Live/ }));
  await screen.findByText("new_to_live");
  answerRead(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByText("new_to_live")).toBeTruthy();
});
