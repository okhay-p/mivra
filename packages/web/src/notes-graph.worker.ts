// Lays out a notes graph off the main thread. See `useNotesGraphLayout` in NotesGraph.tsx for the other end.
import { layoutNotesGraph, type NotesGraphLayout, type LayoutInput } from "./notes-graph-layout.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; view: LayoutInput }>) => void) | null;
  postMessage(message: { id: number; layout: NotesGraphLayout }): void;
};

scope.onmessage = (event) => {
  const { id, view } = event.data;
  scope.postMessage({ id, layout: layoutNotesGraph(view) });
};
