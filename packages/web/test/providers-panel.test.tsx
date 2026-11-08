import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderKeysView } from "../src/api.js";
import { ProvidersPanel } from "../src/ProvidersPanel.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type ChatGpt = NonNullable<ProviderKeysView["chatgpt"]>;
const signedOut: ChatGpt = { signedIn: false, email: null, name: null, pending: false, previous: null, notice: null, welcome: false };
const view = (
  over: Partial<Record<"openrouter" | "anthropic" | "openai", { source: "env" | "saved"; hint: string | null }>> = {},
  canEdit = true,
  chatgpt: Partial<ChatGpt> | null = {},
): ProviderKeysView => ({
  canEdit,
  chatgpt: chatgpt && { ...signedOut, ...chatgpt },
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
    expect(await screen.findByText(/needs a model provider before it can teach: sign in with ChatGPT/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeTruthy();
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
    const error = await screen.findByText("That's too short to be an API key");
    const input = screen.getByLabelText("OpenAI API key");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    expect((input as HTMLInputElement).value).toBe("short");
  });

  it("signs in with ChatGPT in a new tab, then shows the account once the server finishes", async () => {
    const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const fetch = openPanel(
      {},
      json(view()),
      json({ url: "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client" }),
      json(view({}, true, { pending: true })),
      json(view({}, true, { signedIn: true, email: "learner@example.com" })),
    );
    const changed = vi.fn();
    window.addEventListener("mivra:providers-changed", changed);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with ChatGPT" }));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(await screen.findByText(/Waiting for you to approve Mivra/)).toBeTruthy();
    expect(tab.location.href).toContain("https://auth.openai.com/api/accounts/authorize");
    expect(tab.opener).toBeNull();
    expect(String(fetch.mock.calls[1]![0])).toContain("/api/settings/chatgpt/sign-in");
    expect(await screen.findByText("learner@example.com", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Manage ChatGPT usage/ }).getAttribute("href")).toBe("https://chatgpt.com/settings/usage");
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("mivra:providers-changed", changed);
    open.mockRestore();
  });

  it("finishes a ChatGPT sign-in from a pasted address", async () => {
    const fetch = openPanel({}, json(view({}, true, { pending: true })), json({ error: "That address is from a different sign-in." }, 400), json(view({}, true, { signedIn: true, email: "a@b.c" })));
    const input = await screen.findByLabelText("Browser showing an error page?");
    fireEvent.change(input, { target: { value: "http://127.0.0.1:1455/auth/callback?code=c&state=old" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText("That address is from a different sign-in.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "http://127.0.0.1:1455/auth/callback?code=c&state=new" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText("a@b.c")).toBeTruthy();
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({ address: "http://127.0.0.1:1455/auth/callback?code=c&state=new" });
  });

  it("offers to reconnect the previous ChatGPT account or use a different one, and explains why it signed out", async () => {
    openPanel({}, json(view({}, true, { previous: "learner@example.com", notice: "Your ChatGPT sign-in has expired." })));
    expect(await screen.findByText("Reconnect to ChatGPT")).toBeTruthy();
    expect(screen.getByText(/Signs in as learner@example.com/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a different account" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Your ChatGPT sign-in has expired.");
  });

  it("counts a ChatGPT sign-in as a provider", async () => {
    const { hasAnyKey } = await import("../src/ProvidersPanel.js");
    expect(hasAnyKey(view({}, true, { signedIn: true }))).toBe(true);
    expect(hasAnyKey(view())).toBe(false);
  });

  it("lets a browser on another machine sign in with ChatGPT by pasting the address back, though not change keys", async () => {
    openPanel({}, json(view({}, false, { pending: true })));
    expect(await screen.findByLabelText("Paste the address from the ChatGPT tab")).toBeTruthy();
    expect(screen.getByText(/isn't on the computer running Mivra/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Paste your API key")).toBeNull();
  });
});
