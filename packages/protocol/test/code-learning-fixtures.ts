import type { CodeWalkthroughSpec, GraphSpec } from "../src/index.js";

/** Acceptance example 1 of #98: a plain function's parameter and locals, then its return value, with no array. */
export const functionWalkthrough = {
  title: "Calling area(3, 4)",
  code: {
    language: "Python",
    source: "def area(width, height):\n    result = width * height\n    return result\n\nprint(area(3, 4))\n",
  },
  steps: [
    { label: "Call", explanation: "The last line calls area with 3 and 4.", lines: [5], variables: [], output: "" },
    { label: "Parameters", explanation: "Inside area, width is 3 and height is 4.", lines: [1], variables: [{ name: "width", value: 3 }, { name: "height", value: 4 }], output: "" },
    {
      explanation: "result is width times height.",
      lines: [2],
      variables: [{ name: "width", value: 3 }, { name: "height", value: 4 }, { name: "result", value: 12 }],
      output: "",
    },
    { label: "Return", explanation: "area returns 12 and print shows it.", lines: [3, 5], variables: [{ name: "return value", value: 12 }], output: "12\n" },
  ],
} satisfies CodeWalkthroughSpec;

/**
 * Acceptance example 2 of #98: a React counter. The handler still sees the count of the render it belongs to, and
 * the new count and its output only appear at the next render.
 */
export const counterWalkthrough = {
  title: "A click on Counter",
  code: {
    language: "JSX",
    source: [
      "function Counter() {",
      "  const [count, setCount] = useState(0);",
      "  function handleClick() {",
      "    setCount(count + 1);",
      "  }",
      "  return <button onClick={handleClick}>Count: {count}</button>;",
      "}",
    ].join("\n"),
  },
  steps: [
    { label: "Initial render", explanation: "The first render reads count as 0.", lines: [2, 6], variables: [{ name: "render.count", value: 0 }], output: "Count: 0" },
    {
      label: "Click handler",
      explanation: "The click runs handleClick. It still sees count as 0 and queues an update to 1.",
      lines: [3, 4],
      variables: [{ name: "handler.count", value: 0 }, { name: "queued update", value: "count + 1 = 1" }],
      output: "Count: 0",
    },
    { label: "Render 2", explanation: "React renders Counter again, and now count is 1.", lines: [2, 6], variables: [{ name: "render.count", value: 1 }], output: "Count: 1" },
  ],
} satisfies CodeWalkthroughSpec;

/** #99's component-tree example: App renders Counter, which owns count and passes it to CounterLabel. */
export const componentTree = {
  title: "Where count lives",
  directed: true,
  kind: "tree",
  nodes: [{ id: "app", label: "App" }, { id: "counter", label: "Counter" }, { id: "label", label: "CounterLabel" }, { id: "button", label: "Button" }],
  edges: [
    { from: "app", to: "counter" },
    { from: "counter", to: "label", label: "count" },
    { from: "counter", to: "button", label: "onClick" },
  ],
  steps: [
    { explanation: "Counter owns the count state.", nodeStates: [{ id: "counter" }], variables: [{ name: "count", value: 0 }] },
    {
      explanation: "Counter passes count to CounterLabel as a prop, which shows it.",
      nodeStates: [{ id: "counter", tone: "done" }, { id: "label" }],
      edgeStates: [{ from: "counter", to: "label" }],
      variables: [{ name: "count", value: 0 }],
    },
    {
      explanation: "Button gets onClick, which asks Counter to update count.",
      nodeStates: [{ id: "button" }],
      edgeStates: [{ from: "counter", to: "button" }],
      variables: [{ name: "count", value: 0 }],
    },
  ],
} satisfies GraphSpec;
