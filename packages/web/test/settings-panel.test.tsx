import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogModel, ModelPickerView, ModelSelection, ModelTaskView } from "../src/api.js";
import { SettingsPanel } from "../src/SettingsPanel.js";

const model = (id: string, name: string, reasoning: CatalogModel["reasoning"] = null): CatalogModel => ({
  id: `openrouter:${id}`,
  name,
  contextLength: 1000,
  price: null,
  reasoning,
});
const main = model("vendor/main", "Vendor: Main", { efforts: ["low", "high"], defaultEffort: null });
const cheap = model("vendor/cheap", "Vendor: Cheap", { efforts: ["low", "max"], defaultEffort: null });
const picker: ModelPickerView = {
  current: { model: main.id, effort: "high" },
  recent: [main.id],
  pinned: [],
  suggested: [cheap.id],
  models: [main, cheap],
  catalog: "fresh",
  providers: [],
  unavailable: null,
};
const inherited: ModelTaskView = { id: "lesson", override: null, effective: picker.current, unavailable: null };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the picker and the task list; a PUT saves an override and a DELETE resets it. */
function serve(task: ModelTaskView) {
  const calls: { method: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = String(request?.url ?? input);
    const method = init?.method ?? request?.method ?? "GET";
    if (url.includes("/settings/tasks/lesson")) {
      const body = method === "PUT" ? (JSON.parse(String(init?.body ?? (await request!.text()))) as ModelSelection) : undefined;
      calls.push({ method, body });
      return json(body ? { id: "lesson", override: body, effective: body, unavailable: null } : inherited);
    }
    if (url.includes("/settings/tasks")) return json({ tasks: [task] });
    return json(picker);
  });
  return calls;
}

beforeAll(() => {
  // cmdk scrolls the active item into view; jsdom has no layout.
  Element.prototype.scrollIntoView ??= () => {};
});

describe("SettingsPanel", () => {
  it("shows lesson generation following the main model, and saves an override when a model is chosen", async () => {
    const calls = serve(inherited);
    render(<SettingsPanel open onOpenChange={() => {}} />);
    const row = await screen.findByRole("group", { name: "Lesson generation" });
    expect(within(row).getByText("Uses main model")).toBeTruthy();
    expect(row.textContent).toContain("Follows the main model, now Main");
    expect(within(row).queryByRole("button", { name: "Use main model" })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Lesson model: Main. Change model" }));
    fireEvent.click(await screen.findByRole("option", { name: /Vendor: Cheap/ }));
    // The main model's effort isn't one Cheap offers, so the override uses Cheap's default.
    await waitFor(() => expect(calls).toEqual([{ method: "PUT", body: { model: cheap.id, effort: null } }]));
    expect(await within(row).findByText("Own model")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Lesson model: Cheap. Change model" })).toBeTruthy();
    // No pin: pinning belongs to the main picker.
    expect(within(row).queryByRole("button", { name: /^Pin / })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Use main model" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: "DELETE", body: undefined }));
    expect(await within(row).findByText("Uses main model")).toBeTruthy();
  });

  it("explains an override that can't run, with a way back to the main model", async () => {
    serve({ id: "lesson", override: { model: cheap.id, effort: "max" }, effective: { model: cheap.id, effort: "max" }, unavailable: 'Vendor: Cheap no longer offers the "max" effort.' });
    render(<SettingsPanel open onOpenChange={() => {}} />);
    const row = await screen.findByRole("group", { name: "Lesson generation" });
    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toContain("Cheap can't be used for this task");
    expect(alert.textContent).toContain('no longer offers the "max" effort');
    expect(within(row).getByRole("button", { name: "Use main model" })).toBeTruthy();
  });
});
