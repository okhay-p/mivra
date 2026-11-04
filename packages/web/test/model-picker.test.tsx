import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogModel, ModelPickerView } from "../src/api.js";
import { ModelPicker, searchModels, shortModelName, useModelPicker } from "../src/ModelPicker.js";

const model = (id: string, name: string, reasoning: CatalogModel["reasoning"] = null): CatalogModel => ({
  id: `openrouter:${id}`,
  name,
  contextLength: 200000,
  price: { input: 3, output: 15 },
  reasoning,
});
const sonnet = model("anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5", { efforts: ["low", "medium", "high", "max"], defaultEffort: "high" });
const flash = model("google/gemini-3.8-flash", "Google: Gemini 3.8 Flash", { efforts: ["low", "high"], defaultEffort: "low" });
const plain = model("vendor/plain", "Vendor: Plain");
const others = Array.from({ length: 52 }, (_, i) => model(`vendor/other-${i}`, `Vendor: Other ${i}`));

const picker = (over: Partial<ModelPickerView> = {}): ModelPickerView => ({
  current: { model: sonnet.id, effort: "medium" },
  recent: [sonnet.id],
  pinned: [],
  suggested: [flash.id],
  models: [sonnet, flash, plain, ...others],
  catalog: "fresh",
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the picker, and records each PUT. */
function serve(view: ModelPickerView, reply: (url: string, body: unknown) => Response = (_url, body) => json(body)) {
  const puts: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "PUT" || (input instanceof Request && input.method === "PUT")) {
      const body = JSON.parse(String(init?.body ?? (await (input as Request).text())));
      puts.push({ url, body });
      return url.endsWith("/pinned-models") ? json({ pinned: body.models }) : reply(url, body);
    }
    return json(view);
  });
  return puts;
}

function Harness() {
  return <ModelPicker state={useModelPicker()} />;
}

beforeAll(() => {
  // cmdk scrolls the active item into view; jsdom has no layout.
  Element.prototype.scrollIntoView ??= () => {};
});

describe("ModelPicker", () => {
  it("names models without their vendor prefix, and searches every word", () => {
    expect(shortModelName(sonnet.id, [sonnet])).toBe("Claude Sonnet 5.5");
    expect(shortModelName("anthropic:claude-direct")).toBe("claude-direct");
    expect(searchModels([sonnet, flash, plain], "claude 5.5").map((m) => m.id)).toEqual([sonnet.id]);
    expect(searchModels([sonnet, flash, plain], "GOOGLE flash").map((m) => m.id)).toEqual([flash.id]);
  });

  it("opens on the learner's own models, and searches the whole list when they type", async () => {
    serve(picker({ pinned: [plain.id] }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Model: Claude Sonnet 5.5. Change model" }));
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("Pinned")).toBeTruthy();
    expect(within(list).getByText("Recent")).toBeTruthy();
    expect(within(list).getByText("Suggested")).toBeTruthy();
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Vendor: Plain"),
      expect.stringContaining("Anthropic: Claude Sonnet 5.5"),
      expect.stringContaining("Google: Gemini 3.8 Flash"),
    ]);
    expect(within(list).queryByText("Vendor: Other 1")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Choose a model" }), { target: { value: "other" } });
    expect(await within(list).findByText("First 50 of 52 matches")).toBeTruthy();
    // Counted directly: role queries over this many rows are slow in jsdom.
    expect(list.querySelectorAll("[role=option]")).toHaveLength(50);
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a model" }), { target: { value: "nothing like this" } });
    expect(await within(list).findByText("No models match.")).toBeTruthy();
    // Renders 50 rows: about 2 s alone, and far more when every suite runs at once.
  }, 20_000);

  it("keeps the effort when the new model supports it, and falls back to the default when it doesn't", async () => {
    const puts = serve(picker({ current: { model: sonnet.id, effort: "high" } }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /^Model: / }));
    fireEvent.click(await screen.findByRole("option", { name: /Gemini 3.8 Flash/ }));
    await waitFor(() => expect(puts.at(-1)).toEqual({ url: expect.stringMatching(/\/api\/settings\/model$/), body: { model: flash.id, effort: "high" } }));
    expect(await screen.findByRole("button", { name: "Model: Gemini 3.8 Flash. Change model" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Model: / }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Choose a model" }), { target: { value: "plain" } });
    fireEvent.click(await screen.findByRole("option", { name: /Vendor: Plain/ }));
    await waitFor(() => expect(puts.at(-1)?.body).toEqual({ model: plain.id, effort: null }));
    // A model that can't reason has no effort control.
    await screen.findByRole("button", { name: "Model: Plain. Change model" });
    expect(screen.queryByRole("button", { name: /Reasoning effort/ })).toBeNull();
  });

  it("offers only the efforts the model supports, plus its default", async () => {
    const puts = serve(picker());
    render(<Harness />);
    const trigger = await screen.findByRole("button", { name: "Reasoning effort: Medium. Change effort" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Default (High)", "Low", "Medium", "High", "Max"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default (High)" }));
    await waitFor(() => expect(puts.at(-1)?.body).toEqual({ model: sonnet.id, effort: null }));
    expect(await screen.findByRole("button", { name: "Reasoning effort: the model's default. Change effort" })).toBeTruthy();
  });

  it("pins and unpins the current model", async () => {
    const puts = serve(picker({ pinned: [plain.id] }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin Claude Sonnet 5.5" }));
    await waitFor(() => expect(puts.at(-1)?.body).toEqual({ models: [plain.id, sonnet.id] }));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin Claude Sonnet 5.5" }));
    await waitFor(() => expect(puts.at(-1)?.body).toEqual({ models: [plain.id] }));
  });

  it("shows the server's reason when a change is refused, and says when the list is a saved copy", async () => {
    serve(picker({ catalog: "stale" }), () => json({ error: "The model list couldn't be loaded, so the model can't be checked. Try again later." }, 503));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /^Model: / }));
    expect(await screen.findByText("Couldn't refresh OpenRouter's model list, so this is a saved copy.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("option", { name: /Gemini 3.8 Flash/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("can't be checked");
    // The selection didn't change.
    expect(screen.getByRole("button", { name: "Model: Claude Sonnet 5.5. Change model" })).toBeTruthy();
  });
});
