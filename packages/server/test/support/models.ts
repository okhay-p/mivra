import type { ModelSelection } from "../../src/model.js";

/** A fixed model selection for runners built without the HTTP app. */
export const fixedModel = { forRun: (): ModelSelection => ({ model: "test:model", effort: null }) };
