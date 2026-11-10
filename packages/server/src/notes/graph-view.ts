import {
  MAX_GRAPH_FACETS,
  MAX_GRAPH_VIEW_EDGES,
  MAX_GRAPH_VIEW_NODES,
  MAX_GRAPH_VIEW_NOTES,
  WHOLE_GRAPH_NOTES,
  type ConceptGraph,
  type NoteGraph,
  type NoteGraphView,
  type NoteGraphViewQuery,
} from "@mivra/protocol";

type ViewNode = NoteGraphView["nodes"][number];
type ViewEdge = NoteGraphView["edges"][number];

/** A tag or concept: drawn as a node of its own that connects the notes carrying or covering it. */
interface Hub {
  id: string;
  kind: "tag" | "concept";
  label: string;
  /** Matching notes it connects, in path order. */
  notes: number[];
}

export const normalTag = (tag: string) => tag.trim().replace(/^#+/, "").toLowerCase();
export const normalFolder = (folder: string) => folder.trim().replace(/^\/+|\/+$/g, "");
const ghostKey = (target: string) => target.trim().toLowerCase();

/**
 * What a graph view of one import draws (ADR-014 step 4). Many vaults have few links, so tags and concepts are
 * nodes too, connecting the notes that carry or cover them. Under WHOLE_GRAPH_NOTES matching notes the whole graph
 * is drawn; above that, the local graph around a focus note, found breadth-first, where sharing a tag or concept
 * counts as one hop, as a link does. Either way the result is bounded by the MAX_GRAPH_VIEW_* limits, so the
 * payload and the browser's layout stay small for a 10,000-note vault. Deterministic: ties go to path order.
 *
 * `concepts` may hold concepts from other imports; only their sources among this import's notes count.
 */
export function noteGraphView(graph: NoteGraph, concepts: ConceptGraph, query: NoteGraphViewQuery): NoteGraphView {
  const notes = [...graph.notes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const indexOf = new Map(notes.map((note, i) => [note.id, i]));

  const tagFilter = query.tag ? normalTag(query.tag) : "";
  const folderFilter = query.folder ? normalFolder(query.folder) : "";
  const matches = notes.map(
    (note) =>
      (!tagFilter || note.tags.some((tag) => tag === tagFilter || tag.startsWith(`${tagFilter}/`))) &&
      (!folderFilter || note.path.startsWith(`${folderFilter}/`)),
  );
  const matchingNotes = matches.filter(Boolean).length;

  // Links between matching notes, once per pair whichever way they point, and unresolved links as ghosts.
  const linked = notes.map(() => new Set<number>());
  const linkEdges: [number, number][] = [];
  const ghosts = new Map<string, { label: string; from: Set<number> }>();
  for (const link of graph.links) {
    const from = indexOf.get(link.from);
    if (from === undefined || !matches[from]) continue;
    if (link.to === null) {
      const key = ghostKey(link.target);
      if (!key) continue;
      const ghost = ghosts.get(key) ?? { label: link.target.trim(), from: new Set() };
      ghost.from.add(from);
      ghosts.set(key, ghost);
      continue;
    }
    const to = indexOf.get(link.to);
    if (to === undefined || to === from || !matches[to] || linked[from]!.has(to)) continue;
    linked[from]!.add(to);
    linked[to]!.add(from);
    linkEdges.push([from, to]);
  }

  // Tags and concepts, each with the matching notes it connects.
  const hubsOf = notes.map(() => [] as Hub[]);
  const hubs: Hub[] = [];
  const conceptHubs = new Map<string, Hub>();
  for (const concept of concepts.concepts) {
    const covered = [...new Set(concept.notes.flatMap((id) => (matches[indexOf.get(id) ?? -1] ? [indexOf.get(id)!] : [])))].sort((a, b) => a - b);
    if (covered.length === 0) continue;
    const hub: Hub = { id: `concept:${concept.id}`, kind: "concept", label: concept.name, notes: covered };
    conceptHubs.set(concept.id, hub);
    hubs.push(hub);
  }
  const tagHubs = new Map<string, Hub>();
  notes.forEach((note, i) => {
    if (!matches[i]) return;
    for (const tag of new Set(note.tags)) {
      let hub = tagHubs.get(tag);
      if (!hub) {
        hub = { id: `tag:${tag}`, kind: "tag", label: `#${tag}`, notes: [] };
        tagHubs.set(tag, hub);
        hubs.push(hub);
      }
      hub.notes.push(i);
    }
  });
  // Concepts first: a concept says more about what two notes share than a tag does.
  for (const hub of hubs) for (const i of hub.notes) hubsOf[i]!.push(hub);

  const facets = facetsOf(notes);
  const connections = (i: number) => linked[i]!.size + hubsOf[i]!.length;
  const byConnections = () => {
    let best = -1;
    notes.forEach((_, i) => {
      if (matches[i] && (best < 0 || connections(i) > connections(best))) best = i;
    });
    return best;
  };
  const requested = query.focus === undefined ? undefined : indexOf.get(query.focus);
  const validFocus = requested !== undefined && matches[requested] ? requested : undefined;
  const whole = query.mode === "auto" && matchingNotes <= WHOLE_GRAPH_NOTES;
  const focus = whole ? validFocus : (validFocus ?? byConnections());
  let truncated = false;

  // Which notes are drawn, with how far each is from the focus in the local graph.
  const hops = new Map<number, number>();
  if (whole) {
    notes.forEach((_, i) => {
      if (matches[i]) hops.set(i, 0);
    });
  } else if (focus !== undefined && focus >= 0) {
    hops.set(focus, 0);
    const expanded = new Set<Hub>();
    let frontier = [focus];
    for (let hop = 1; hop <= query.depth && frontier.length > 0 && !truncated; hop++) {
      const next: number[] = [];
      const reach = (i: number) => {
        if (hops.has(i)) return true;
        if (hops.size >= MAX_GRAPH_VIEW_NOTES) return false;
        hops.set(i, hop);
        next.push(i);
        return true;
      };
      for (const i of frontier) {
        for (const j of [...linked[i]!].sort((a, b) => a - b)) if (!reach(j)) truncated = true;
        for (const hub of hubsOf[i]!) {
          if (expanded.has(hub)) continue;
          expanded.add(hub);
          for (const j of hub.notes) if (!reach(j)) truncated = true;
        }
        if (truncated) break;
      }
      frontier = next;
    }
  }

  // Nodes: notes first, then the tags and concepts connecting the most drawn notes, then ghosts, up to the limit.
  const nodes: ViewNode[] = [];
  const drawn = new Set<string>();
  const add = (node: ViewNode) => {
    if (nodes.length >= MAX_GRAPH_VIEW_NODES) {
      truncated = true;
      return;
    }
    nodes.push(node);
    drawn.add(node.id);
  };
  const shown = [...hops.keys()].sort((a, b) => a - b).slice(0, MAX_GRAPH_VIEW_NOTES);
  if (shown.length < hops.size) truncated = true;
  for (const i of shown) {
    const note = notes[i]!;
    add({ id: note.id, kind: "note", label: note.title, path: note.path, ...(whole ? {} : { hops: hops.get(i)! }) });
  }
  const drawnNotes = (hub: Hub) => hub.notes.filter((i) => drawn.has(notes[i]!.id));
  // The local graph draws a tag or concept only where it connects two drawn notes or touches the focus, so the
  // outer ring isn't fringed with tags that lead nowhere drawn.
  const hubCandidates = hubs
    .map((hub) => ({ hub, drawnCount: drawnNotes(hub).length }))
    .filter(({ hub, drawnCount }) => drawnCount > 0 && (whole || drawnCount > 1 || (focus !== undefined && hub.notes.includes(focus))))
    .sort((a, b) => b.drawnCount - a.drawnCount || (a.hub.kind === b.hub.kind ? 0 : a.hub.kind === "concept" ? -1 : 1));
  for (const { hub } of hubCandidates) add({ id: hub.id, kind: hub.kind, label: hub.label, notes: hub.notes.length });
  for (const [key, ghost] of ghosts) {
    if ([...ghost.from].some((i) => drawn.has(notes[i]!.id))) add({ id: `ghost:${key}`, kind: "ghost", label: ghost.label });
  }

  // Edges between drawn nodes, the most telling first, up to the limit.
  const edges: ViewEdge[] = [];
  const edge = (from: string, to: string, kind: ViewEdge["kind"]) => {
    if (!drawn.has(from) || !drawn.has(to)) return;
    if (edges.length >= MAX_GRAPH_VIEW_EDGES) {
      truncated = true;
      return;
    }
    edges.push({ from, to, kind });
  };
  for (const [from, to] of linkEdges) edge(notes[from]!.id, notes[to]!.id, "link");
  for (const conceptEdge of concepts.edges) {
    const from = conceptHubs.get(conceptEdge.from);
    const to = conceptHubs.get(conceptEdge.to);
    if (from && to) edge(from.id, to.id, conceptEdge.kind);
  }
  for (const hub of hubs) for (const i of hub.notes) edge(hub.id, notes[i]!.id, hub.kind);
  for (const [key, ghost] of ghosts) for (const i of ghost.from) edge(notes[i]!.id, `ghost:${key}`, "link");

  return {
    mode: whole ? "whole" : "local",
    focus: focus === undefined || focus < 0 ? null : notes[focus]!.id,
    depth: query.depth,
    totalNotes: notes.length,
    matchingNotes,
    truncated,
    nodes,
    edges,
    ...facets,
  };
}

/** The import's tags and folders with how many notes each holds, the fullest first, for the filters. */
function facetsOf(notes: NoteGraph["notes"]) {
  const tagCounts = new Map<string, number>();
  for (const note of notes) for (const tag of new Set(note.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const tags = [...tagCounts]
    .sort(([a, x], [b, y]) => y - x || compare(a, b))
    .slice(0, MAX_GRAPH_FACETS)
    .map(([name, count]) => ({ name, notes: count }));
  return { tags, folders: topFolders(notes) };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A folder as the run of notes under it in path order: `notes[from..to)` all start with `path` + "/". */
interface Folder {
  path: string;
  from: number;
  to: number;
}

/** Fuller folders first, ties by path, as a heap's order. */
const before = (a: Folder, b: Folder) => b.to - b.from - (a.to - a.from) || compare(a.path, b.path);

/**
 * The MAX_GRAPH_FACETS fullest folders, ties by path, with `notes` sorted by path. Listing every folder of every
 * path first would cost the square of a path's depth per note (a hostile vault of 10,000 notes, each hundreds of
 * folders deep, took over a minute). Instead, as the notes under a folder are one run in path order, and a folder
 * never holds more notes than its parent and sorts before it, this opens folders best first from the root, only
 * splitting the runs of the folders it lists into their subfolders, found by bisection. So the work grows with the
 * folders listed and their subfolders, plus one look at each note filed directly in a listed folder.
 */
function topFolders(notes: NoteGraph["notes"]): { path: string; notes: number }[] {
  const heap: Folder[] = [];
  const push = (folder: Folder) => {
    let i = heap.push(folder) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(heap[parent]!, heap[i]!) <= 0) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const smaller = left + 1 < heap.length && before(heap[left + 1]!, heap[left]!) < 0 ? left + 1 : left;
        if (smaller >= heap.length || before(heap[i]!, heap[smaller]!) <= 0) break;
        [heap[smaller], heap[i]] = [heap[i]!, heap[smaller]!];
        i = smaller;
      }
    }
    return top;
  };
  /** Pushes the subfolders of the folder whose notes are `notes[from..to)` and whose paths go on at `start`. */
  const open = (from: number, to: number, start: number) => {
    for (let i = from; i < to; ) {
      const path = notes[i]!.path;
      const end = path.indexOf("/", start);
      if (end < 0) {
        i++;
        continue;
      }
      // The subfolder's notes are one run from here: find where it ends by bisection rather than note by note.
      const prefix = path.slice(0, end + 1);
      let after = i + 1;
      for (let last = to; after < last; ) {
        const mid = (after + last) >> 1;
        if (notes[mid]!.path.startsWith(prefix)) after = mid + 1;
        else last = mid;
      }
      push({ path: path.slice(0, end), from: i, to: after });
      i = after;
    }
  };
  open(0, notes.length, 0);
  const folders: { path: string; notes: number }[] = [];
  while (heap.length > 0 && folders.length < MAX_GRAPH_FACETS) {
    const folder = pop();
    folders.push({ path: folder.path, notes: folder.to - folder.from });
    open(folder.from, folder.to, folder.path.length + 1);
  }
  return folders;
}
