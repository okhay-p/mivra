import type { CompositionSpec } from "../src/index.js";

/**
 * Acceptance fixture 1 of #109: Python aliasing. a and b refer to one list, appending through b changes the
 * list both see, and rebinding b swaps which connection is shown while both lists stay visible.
 */
export const aliasingComposition = {
  title: "Two names, one list",
  groups: [
    { id: "names", label: "Names", ordered: false },
    { id: "heap", label: "Objects", ordered: false },
  ],
  entities: [
    { id: "a", label: "a", properties: [] },
    { id: "b", label: "b", properties: [] },
    { id: "list1", label: "list", properties: [{ name: "items", value: "[1, 2, 3]" }, { name: "length", value: 3 }] },
    { id: "list2", label: "new list", properties: [{ name: "items", value: "[9]" }, { name: "length", value: 1 }] },
  ],
  connections: [
    { id: "a_list1", from: "a", to: "list1" },
    { id: "b_list1", from: "b", to: "list1" },
    { id: "b_list2", from: "b", to: "list2" },
  ],
  steps: [
    {
      label: "a = [1, 2, 3]",
      explanation: "Python makes a list object and binds the name a to it.",
      placements: [{ groupId: "names", entityIds: ["a"] }, { groupId: "heap", entityIds: ["list1"] }],
      hidden: ["b", "list2"],
      connections: ["a_list1"],
    },
    {
      label: "b = a",
      explanation: "Assignment copies the reference, not the list: b now refers to the same object as a.",
      placements: [{ groupId: "names", entityIds: ["a", "b"] }, { groupId: "heap", entityIds: ["list1"] }],
      hidden: ["list2"],
      connections: ["a_list1", "b_list1"],
      emphasis: [{ entityId: "b", tone: "active" }],
    },
    {
      label: "b.append(4)",
      explanation: "Appending through b changes the one list, so a sees the new item too.",
      placements: [{ groupId: "names", entityIds: ["a", "b"] }, { groupId: "heap", entityIds: ["list1"] }],
      hidden: ["list2"],
      connections: ["a_list1", "b_list1"],
      state: [{ entityId: "list1", properties: [{ name: "items", value: "[1, 2, 3, 4]" }, { name: "length", value: 4 }] }],
      emphasis: [{ entityId: "list1", tone: "active" }],
      callouts: [{ entityId: "list1", text: "Changed in place: still the same object." }],
    },
    {
      label: "b = [9]",
      explanation: "Rebinding b points it at a new list. The first list is untouched and a still refers to it.",
      placements: [{ groupId: "names", entityIds: ["a", "b"] }, { groupId: "heap", entityIds: ["list1", "list2"] }],
      hidden: [],
      connections: ["a_list1", "b_list2"],
      state: [{ entityId: "list1", properties: [{ name: "items", value: "[1, 2, 3, 4]" }, { name: "length", value: 4 }] }],
      emphasis: [{ entityId: "list2", tone: "active" }],
    },
  ],
} satisfies CompositionSpec;

/** Acceptance fixture 2 of #109: an interpreter pipeline, with short code and maths bodies and literal step labels. */
export const pipelineComposition = {
  title: "From source to bytecode",
  groups: [
    { id: "source", label: "Source", ordered: false },
    { id: "lexer", label: "Tokens", ordered: false },
    { id: "parser", label: "AST", ordered: false },
    { id: "compiler", label: "Bytecode", ordered: false },
  ],
  entities: [
    { id: "src", label: "program", properties: [{ name: "lines", value: 1 }], body: [{ type: "code", language: "Python", code: "x = 1 + 2" }] },
    { id: "tokens", label: "token stream", properties: [{ name: "count", value: 5 }], body: [{ type: "text", text: "NAME x, OP =, NUMBER 1, OP +, NUMBER 2" }] },
    {
      id: "ast",
      label: "Assign node",
      properties: [{ name: "target", value: "x" }],
      body: [{ type: "math", source: "x \\gets (1 + 2)" }, { type: "text", text: "A tree: the sum is the child of the assignment, so $1 + 2$ is worked out first." }],
    },
    {
      id: "bytecode",
      label: "code object",
      properties: [{ name: "constant folded", value: true }],
      body: [{ type: "code", language: "bytecode", code: "LOAD_CONST   3\nSTORE_NAME   x\n" }],
    },
  ],
  connections: [
    { id: "lexed", from: "tokens", to: "src", label: "read from" },
    { id: "parsed", from: "ast", to: "tokens", label: "built from" },
    { id: "compiled", from: "bytecode", to: "ast", label: "compiled from" },
  ],
  steps: [
    {
      explanation: "The interpreter starts with nothing but the source text.",
      placements: [{ groupId: "source", entityIds: ["src"] }, { groupId: "lexer", entityIds: [] }, { groupId: "parser", entityIds: [] }, { groupId: "compiler", entityIds: [] }],
      hidden: ["tokens", "ast", "bytecode"],
      connections: [],
    },
    {
      label: "tokenize",
      explanation: "The lexer splits the text into five tokens.",
      placements: [{ groupId: "source", entityIds: ["src"] }, { groupId: "lexer", entityIds: ["tokens"] }, { groupId: "parser", entityIds: [] }, { groupId: "compiler", entityIds: [] }],
      hidden: ["ast", "bytecode"],
      connections: ["lexed"],
      emphasis: [{ entityId: "tokens", tone: "active" }, { entityId: "src", tone: "done" }],
    },
    {
      label: "parse",
      explanation: "The parser arranges the tokens into a tree.",
      placements: [{ groupId: "source", entityIds: ["src"] }, { groupId: "lexer", entityIds: ["tokens"] }, { groupId: "parser", entityIds: ["ast"] }, { groupId: "compiler", entityIds: [] }],
      hidden: ["bytecode"],
      connections: ["lexed", "parsed"],
      emphasis: [{ entityId: "ast", tone: "active" }, { entityId: "tokens", tone: "done" }, { entityId: "src", tone: "muted" }],
    },
    {
      label: "compile",
      explanation: "The compiler walks the tree and emits bytecode, folding $1 + 2$ into 3.",
      placements: [{ groupId: "compiler", entityIds: ["bytecode"] }, { groupId: "parser", entityIds: ["ast"] }, { groupId: "lexer", entityIds: ["tokens"] }, { groupId: "source", entityIds: ["src"] }],
      hidden: [],
      connections: ["lexed", "parsed", "compiled"],
      emphasis: [{ entityId: "bytecode", tone: "active" }],
    },
  ],
} satisfies CompositionSpec;

/**
 * Acceptance fixture 3 of #109, and the visual reference for #114: an event loop. One task id moves from the
 * queue to the stack and then out of sight, the queue's front is its first entity, and one step only
 * reorders the queue.
 */
export const eventLoopComposition = {
  title: "One turn of the event loop",
  groups: [
    { id: "queue", label: "Task queue", ordered: true },
    { id: "stack", label: "Call stack", ordered: true },
  ],
  entities: [
    { id: "timer", label: "onTimeout", properties: [{ name: "delay", value: 0 }] },
    { id: "click", label: "onClick", properties: [{ name: "priority", value: "normal" }] },
    { id: "fetch", label: "onResponse", properties: [] },
  ],
  connections: [],
  steps: [
    {
      explanation: "Three tasks wait in the queue. The front of the queue is at the top.",
      placements: [{ groupId: "queue", entityIds: ["timer", "click", "fetch"] }, { groupId: "stack", entityIds: [] }],
      hidden: [],
      connections: [],
    },
    {
      explanation: "The browser treats the click as user input and moves it to the front.",
      placements: [{ groupId: "queue", entityIds: ["click", "timer", "fetch"] }, { groupId: "stack", entityIds: [] }],
      hidden: [],
      connections: [],
      state: [{ entityId: "click", properties: [{ name: "priority", value: "user input" }] }],
    },
    {
      explanation: "The stack is empty, so the loop takes the front task and runs it.",
      placements: [{ groupId: "queue", entityIds: ["timer", "fetch"] }, { groupId: "stack", entityIds: ["click"] }],
      hidden: [],
      connections: [],
      emphasis: [{ entityId: "click", tone: "active" }],
    },
    {
      explanation: "onClick returns. It is gone, and the stack is empty again.",
      placements: [{ groupId: "queue", entityIds: ["timer", "fetch"] }, { groupId: "stack", entityIds: [] }],
      hidden: ["click"],
      connections: [],
    },
  ],
} satisfies CompositionSpec;

const twelveWideLines = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, "0")}  MOVE FIELD-${i} TO OUTPUT-RECORD`.padEnd(80, ".")).join("\n");

/**
 * Acceptance fixture 4 of #109: rich content at its limits. Labels at their caps, one entity whose body is exactly
 * 1,000 characters with a language nothing highlights, a formula KaTeX can't parse beside one it can, an entity
 * with no properties, two parallel references, a step that removes every property, one that hides everything,
 * and a last step that restores the declared properties.
 */
export const richComposition = {
  title: "Rich content at its limits: long labels, full bodies, an unknown language and a formula that cannot be parsed at all",
  groups: [
    { id: "shelf", label: "A shelf with a long label here!!", ordered: true },
    { id: "spare", label: "Spare", ordered: false },
  ],
  entities: [
    { id: "record", label: "An entity label of 32 characters", properties: [{ name: "status", value: "draft" }, { name: "size", value: 0 }] },
    {
      id: "listing",
      label: "listing",
      properties: [{ name: "lines", value: 12 }],
      body: [
        { type: "code", language: "COBOL-85 dialect", code: twelveWideLines },
        { type: "text", text: "Twelve lines at the line cap." },
      ],
    },
    {
      id: "formulas",
      label: "formulas",
      properties: [],
      body: [
        { type: "math", source: "\\frac{1}{" },
        { type: "math", source: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}" },
      ],
    },
    {
      id: "owner",
      label: "owner",
      properties: [
        { name: "a", value: 1 },
        { name: "b", value: true },
        { name: "c", value: "" },
        { name: "costs $5", value: "$10, not maths" },
        { name: "e", value: -2.5 },
        { name: "f", value: "six" },
      ],
    },
  ],
  connections: [
    { id: "owns", from: "owner", to: "record", label: "owns" },
    { id: "edits", from: "owner", to: "record", label: "edits" },
  ],
  steps: [
    {
      label: "load()",
      explanation: "Everything starts on the shelf; the spare group is empty.",
      placements: [{ groupId: "shelf", entityIds: ["record", "listing", "formulas", "owner"] }, { groupId: "spare", entityIds: [] }],
      hidden: [],
      connections: ["owns", "edits"],
    },
    {
      label: "clear(owner); move(formulas)",
      explanation: "The owner loses every property, the record swaps one, and the formulas move to the spare group.",
      placements: [{ groupId: "shelf", entityIds: ["record", "listing", "owner"] }, { groupId: "spare", entityIds: ["formulas"] }],
      hidden: [],
      connections: ["owns"],
      state: [
        { entityId: "owner", properties: [] },
        { entityId: "record", properties: [{ name: "status", value: "final" }, { name: "pages", value: 3 }] },
      ],
      emphasis: [{ entityId: "owner", tone: "muted" }, { entityId: "record", tone: "done" }],
      callouts: [{ entityId: "owner", text: "Every property is gone at this step." }],
    },
    {
      explanation: "Nothing is on show: everything is hidden.",
      placements: [{ groupId: "shelf", entityIds: [] }, { groupId: "spare", entityIds: [] }],
      hidden: ["record", "listing", "formulas", "owner"],
      connections: [],
    },
    {
      label: "load()",
      explanation: "Back on the shelf, with the declared properties again.",
      placements: [{ groupId: "shelf", entityIds: ["owner", "record", "listing", "formulas"] }, { groupId: "spare", entityIds: [] }],
      hidden: [],
      connections: ["owns", "edits"],
    },
  ],
} satisfies CompositionSpec;
