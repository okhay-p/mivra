import { CHATGPT_USAGE_LIMIT_ERROR } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatGptWelcome, UsageLimitNotice, UsingChatGptPlan } from "../src/ChatGpt.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const chatgpt = { signedIn: true, email: "learner@example.com", name: null, pending: false, previous: null, notice: null };

describe("ChatGPT plan UI (OpenAI's guidelines)", () => {
  it("says when replies use the plan, with Manage usage", () => {
    render(<UsingChatGptPlan />);
    expect(screen.getByText(/Using ChatGPT plan/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Manage ChatGPT usage/ }).getAttribute("href")).toBe("https://chatgpt.com/settings/usage");
  });

  it("makes Manage usage the way forward when the usage limit is reached", () => {
    expect(CHATGPT_USAGE_LIMIT_ERROR).toMatch(/usage limit reached/i);
    render(<UsageLimitNotice />);
    expect(screen.getByRole("alert").textContent).toContain("Usage limit reached");
    expect(screen.getByText("Review your plan or this app's limit in ChatGPT settings.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Manage ChatGPT usage/ })).toBeTruthy();
  });

  it("welcomes the learner once, and records it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(json({ canEdit: true, providers: [], chatgpt: { ...chatgpt, welcome: true } }));
    fetch.mockResolvedValueOnce(json({ canEdit: true, providers: [], chatgpt: { ...chatgpt, welcome: false } }));
    render(<ChatGptWelcome />);
    expect(await screen.findByRole("dialog", { name: "You're using your ChatGPT plan" })).toBeTruthy();
    expect(screen.getByText("Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toContain("/api/settings/chatgpt/welcomed");
    expect(init?.method).toBe("POST");
  });

  it("doesn't welcome a learner who has seen it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ canEdit: true, providers: [], chatgpt: { ...chatgpt, welcome: false } }));
    render(<ChatGptWelcome />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
