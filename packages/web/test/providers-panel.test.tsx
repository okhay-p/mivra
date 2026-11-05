import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderKeysView } from "../src/api.js";
import { ProvidersPanel } from "../src/ProvidersPanel.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const view = (over: Partial<Record<"openrouter" | "anthropic" | "openai", { source: "env" | "saved"; hint: string | null }>> = {}, canEdit = true): ProviderKeysView => ({
  canEdit,
  providers: (["openrouter", "anthropic", "openai"] as const).map((id) => ({
    id,
    label: { openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI" }[id],
    source: over[id]?.source ?? null,
    hint: over[id]?.hint ?? null,
  })),
});
const openPanel = (props: { firstRun?: boolean } = {}, ...responses: Response[]) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  render(<ProvidersPanel open onOpenChange={() => {}} {...props} />);
  return fetch;
};

describe("ProvidersPanel", () => {
  it("explains on first run that a key is needed", async () => {
    openPanel({ firstRun: true }, json(view()));
    expect(await screen.findByText(/needs an API key from one of these providers/)).toBeTruthy();
    expect(screen.getAllByPlaceholderText("Paste your API key")).toHaveLength(3);
  });

  it("saves a key, then checks it with the provider", async () => {
    const fetch = openPanel({}, json(view()), json(view({ openrouter: { source: "saved", hint: "WXYZ" } })), json({ ok: true }));
    const changed = vi.fn();
    window.addEventListener("mivra:providers-changed", changed);
    fireEvent.change(await screen.findByLabelText("OpenRouter API key"), { target: { value: "sk-or-v1-secretWXYZ" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    expect(await screen.findByText("The key works.")).toBeTruthy();
    expect(screen.getByText("Saved · ends in WXYZ.")).toBeTruthy();
    expect(screen.queryByDisplayValue("sk-or-v1-secretWXYZ")).toBeNull();
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toContain("/api/settings/providers/openrouter");
    expect(init?.method).toBe("PUT");
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("mivra:providers-changed", changed);
  });

  it("says when the provider rejects a key", async () => {
    openPanel({}, json(view({ anthropic: { source: "saved", hint: "abcd" } })), json({ ok: false, reason: "rejected", message: "The provider rejected this key." }));
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect(await screen.findByText("The provider rejected this key.")).toBeTruthy();
  });

  it("shows environment keys without letting them be changed", async () => {
    openPanel({}, json(view({ openai: { source: "env", hint: "1234" } })));
    expect(await screen.findByText("Set by OPENAI_API_KEY · ends in 1234. Change it there.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  });

  it("is read-only from another machine", async () => {
    openPanel({}, json(view({ openrouter: { source: "saved", hint: "WXYZ" } }, false)));
    expect(await screen.findByText(/can only be changed on the computer running Mivra/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Paste your API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
  });

  it("shows the server's error when saving fails", async () => {
    openPanel({}, json(view()), json({ error: "That's too short to be an API key" }, 400));
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), { target: { value: "short" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[2]!);
    expect(await screen.findByText("That's too short to be an API key")).toBeTruthy();
  });
});
