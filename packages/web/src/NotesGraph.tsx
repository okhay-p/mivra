import { WHOLE_GRAPH_NOTES, type NoteGraphView, type NoteSummary, type NoteView, type VaultImportView } from "@mivra/protocol";
import { Maximize, Minus, Plus, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { findNotes, getGraphView, getNote, listImports, type GraphViewFilters } from "./api.js";
import { layoutNotesGraph, type NotesGraphLayout } from "./notes-graph-layout.js";

type GraphNode = NoteGraphView["nodes"][number];

const ALL = "__all";
const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
/** Under this many nodes every label is drawn; above it, only those near the selection, so the drawing stays legible. */
const ALL_LABELS_NODES = 150;
/** The smallest a node's hit area gets however far the graph is zoomed out. */
const MIN_HIT_PX = 14;
const SEARCH_DELAY_MS = 200;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** What a screen reader hears for a node; the drawing tells sighted readers the same by shape. */
function nodeName(node: GraphNode, connections: number) {
  const links = plural(connections, "connection");
  switch (node.kind) {
    case "note":
      return `${node.label}, note in ${node.path}, ${links}`;
    case "tag":
      return `${node.label}, tag on ${plural(node.notes ?? 0, "note")}`;
    case "concept":
      return `${node.label}, concept from ${plural(node.notes ?? 0, "note")}`;
    case "ghost":
      return `${node.label}, unresolved link, no such note`;
  }
}

/** The worker that lays graphs out, started when the first graph is drawn. */
let layoutWorker: Worker | undefined;
let layoutRequests = 0;

/**
 * Lays a view out in a worker, so the page stays responsive however long that takes, and returns the latest view
 * with its layout. Until a new view's layout is ready the previous one stays drawn, with `pending` set. A view
 * superseded before its layout is ready stops the worker, so the next doesn't wait behind it. Without workers, or
 * if the worker fails, the layout runs in place.
 */
export function useNotesGraphLayout(view: NoteGraphView | undefined) {
  const [drawn, setDrawn] = useState<{ view: NoteGraphView; layout: NotesGraphLayout }>();
  useEffect(() => {
    if (!view) return;
    const inPlace = () => setDrawn({ view, layout: layoutNotesGraph(view) });
    if (typeof Worker === "undefined") return inPlace();
    let worker: Worker;
    try {
      worker = layoutWorker ??= new Worker(new URL("./notes-graph.worker.ts", import.meta.url), { type: "module", name: "mivra-graph-layout" });
    } catch {
      return inPlace();
    }
    const id = ++layoutRequests;
    let done = false;
    const finish = () => {
      done = true;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent<{ id: number; layout: NotesGraphLayout }>) => {
      if (event.data.id !== id) return;
      finish();
      setDrawn({ view, layout: event.data.layout });
    };
    const onError = () => {
      finish();
      worker.terminate();
      if (layoutWorker === worker) layoutWorker = undefined;
      inPlace();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ id, view: { nodes: view.nodes, edges: view.edges } });
    return () => {
      if (done) return;
      finish();
      worker.terminate();
      if (layoutWorker === worker) layoutWorker = undefined;
    };
  }, [view]);
  return { drawn, pending: Boolean(view && drawn?.view !== view) };
}

/** The graph of an imported vault's notes, tags and concepts (ADR-014 step 4). Read-only: a note opens to be read. */
export function NotesGraph({ importId: initialImport }: { importId: string }) {
  const [importId, setImportId] = useState(initialImport);
  useEffect(() => setImportId(initialImport), [initialImport]);
  const [imports, setImports] = useState<VaultImportView[]>([]);
  useEffect(() => {
    void listImports().then((result) => result.ok && setImports(result.value));
  }, []);

  const [filters, setFilters] = useState<GraphViewFilters>({ mode: "auto", depth: 2 });
  const [state, setState] = useState<{ view?: NoteGraphView; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let stale = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    void getGraphView(importId, filters).then((result) => {
      if (stale) return;
      setState(result.ok ? { view: result.value, loading: false } : { error: result.error, loading: false });
    });
    return () => {
      stale = true;
    };
  }, [importId, filters]);
  const view = state.view;
  const laidOut = useNotesGraphLayout(view);

  const [selected, setSelected] = useState<string>();
  const [reading, setReading] = useState<string>();
  // A new view keeps the selection only if it still draws it; otherwise its focus is selected.
  useEffect(() => {
    if (!view) return;
    setSelected((id) => (id && view.nodes.some((n) => n.id === id) ? id : (view.focus ?? undefined)));
  }, [view]);

  const changeImport = (id: string) => {
    setImportId(id);
    setFilters({ mode: "auto", depth: 2 });
    setSelected(undefined);
  };
  const centreOn = (noteId: string) => {
    setSelected(noteId);
    setFilters((f) => ({ ...f, focus: noteId, mode: view && view.matchingNotes > WHOLE_GRAPH_NOTES ? "local" : f.mode }));
  };
  const onActivate = (node: GraphNode) => {
    setSelected(node.id);
    if (node.kind === "note") setReading(node.id);
  };

  const importName = imports.find((i) => i.id === importId)?.name;
  const tooBigForWhole = Boolean(view && view.matchingNotes > WHOLE_GRAPH_NOTES);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="notes-graph">
      <div className="flex flex-wrap items-end gap-2 border-b p-3" role="toolbar" aria-label="Graph filters">
        <FilterSelect
          label="Import"
          value={importId}
          onChange={changeImport}
          options={(imports.length > 0 ? imports : [{ id: importId, name: "This import" }]).map((i) => ({ value: i.id, text: i.name }))}
        />
        <FilterSelect
          label="Tag"
          value={filters.tag ?? ALL}
          onChange={(tag) => setFilters((f) => ({ ...f, tag: tag === ALL ? undefined : tag }))}
          options={[{ value: ALL, text: "All tags" }, ...withCurrent(view?.tags.map((t) => ({ value: t.name, text: `#${t.name} (${t.notes})` })) ?? [], filters.tag, (t) => `#${t}`)]}
        />
        <FilterSelect
          label="Folder"
          value={filters.folder ?? ALL}
          onChange={(folder) => setFilters((f) => ({ ...f, folder: folder === ALL ? undefined : folder }))}
          options={[{ value: ALL, text: "All folders" }, ...withCurrent(view?.folders.map((f) => ({ value: f.path, text: `${f.path} (${f.notes})` })) ?? [], filters.folder, (f) => f)]}
        />
        <FilterSelect
          label="Show"
          value={filters.mode === "local" || tooBigForWhole ? "local" : "auto"}
          onChange={(mode) => setFilters((f) => ({ ...f, mode: mode as GraphViewFilters["mode"] }))}
          options={[
            { value: "auto", text: tooBigForWhole ? `Whole graph (over ${WHOLE_GRAPH_NOTES} notes)` : "Whole graph", disabled: tooBigForWhole },
            { value: "local", text: "Around the selected note" },
          ]}
        />
        {(filters.mode === "local" || tooBigForWhole) && (
          <FilterSelect
            label="Reach"
            value={String(filters.depth)}
            onChange={(depth) => setFilters((f) => ({ ...f, depth: Number(depth) }))}
            options={[1, 2, 3].map((d) => ({ value: String(d), text: plural(d, "hop") }))}
          />
        )}
        <NoteFinder importId={importId} onPick={(note) => centreOn(note.id)} />
      </div>
      <GraphStatus view={view} loading={state.loading || laidOut.pending} error={state.error} importName={importName} />
      {laidOut.drawn && (
        <NotesGraphDrawing view={laidOut.drawn.view} layout={laidOut.drawn.layout} selected={selected} onSelect={setSelected} onActivate={onActivate} />
      )}
      <NoteReader
        noteId={reading}
        onOpenChange={(open) => !open && setReading(undefined)}
        onCentre={(id) => {
          setReading(undefined);
          setFilters((f) => ({ ...f, mode: "local", focus: id }));
          setSelected(id);
        }}
      />
    </div>
  );
}

/** A filter's choices, keeping the current one even when it's no longer among the fullest listed. */
function withCurrent(options: { value: string; text: string }[], current: string | undefined, text: (value: string) => string) {
  return current && !options.some((o) => o.value === current) ? [{ value: current, text: text(current) }, ...options] : options;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; text: string; disabled?: boolean }[];
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={id} className="text-muted-foreground text-xs">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" aria-labelledby={id} className="max-w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Finds a note by title or path to centre the graph on, which is how a note far from the drawn ones is reached. */
function NoteFinder({ importId, onPick }: { importId: string; onPick: (note: NoteSummary) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<NoteSummary[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound([]);
    let stale = false;
    const timer = setTimeout(() => {
      void findNotes(importId, q).then((result) => {
        if (!stale && result.ok) setFound(result.value);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [importId, query]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Search />
          Find a note
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Title or path" value={query} onValueChange={setQuery} aria-label="Find a note by title or path" />
          <CommandList>
            {query.trim() && <CommandEmpty>No note matches.</CommandEmpty>}
            {found.map((note) => (
              <CommandItem
                key={note.id}
                value={note.id}
                onSelect={() => {
                  setOpen(false);
                  setQuery("");
                  onPick(note);
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{note.title}</span>
                  <span className="text-muted-foreground truncate text-xs">{note.path}</span>
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Says what's drawn and why, so a learner knows when part of a large vault is left out. Announced as it changes. */
function GraphStatus({ view, loading, error, importName }: { view?: NoteGraphView; loading: boolean; error?: string; importName?: string }) {
  let text = "";
  if (view) {
    const count = (kind: GraphNode["kind"]) => view.nodes.filter((n) => n.kind === kind).length;
    const parts = [plural(count("note"), "note"), plural(count("tag"), "tag"), plural(count("concept"), "concept"), plural(count("ghost"), "unresolved link")];
    const focus = view.nodes.find((n) => n.id === view.focus);
    const where =
      view.mode === "whole"
        ? "Whole graph"
        : `Around ${focus?.label ?? "the best-connected note"}, within ${plural(view.depth, "hop")}`;
    const of = view.matchingNotes === view.totalNotes ? plural(view.totalNotes, "note") : `${plural(view.matchingNotes, "matching note")} (${plural(view.totalNotes, "note")} in all)`;
    text = `${where}: ${parts.join(", ")}, of ${of}.${view.truncated ? " Only the nearest are drawn; filter or centre on a note to see others." : ""}`;
    if (view.matchingNotes === 0) text = view.totalNotes === 0 ? "This import has no notes." : "No note matches these filters.";
  }
  return (
    <div className="flex min-h-9 items-center gap-2 border-b px-3 py-1.5 text-sm">
      {importName && <span className="sr-only">{importName}.</span>}
      <p role="status" aria-live="polite" className={cn("min-w-0 flex-1", error ? "text-destructive" : "text-muted-foreground")} data-testid="notes-graph-status">
        {error ?? text}
      </p>
      {loading && <Spinner aria-label="Loading the graph" />}
      <Legend />
    </div>
  );
}

function Legend() {
  const items: [GraphNode["kind"], string][] = [
    ["note", "Note"],
    ["concept", "Concept"],
    ["tag", "Tag"],
    ["ghost", "Unresolved"],
  ];
  return (
    <ul className="text-muted-foreground hidden shrink-0 items-center gap-3 text-xs sm:flex" aria-hidden="true">
      {items.map(([kind, text]) => (
        <li key={kind} className="flex items-center gap-1">
          <svg viewBox="-7 -7 14 14" className="size-3.5 overflow-visible">
            <NodeShape kind={kind} radius={5} emphasis={false} />
          </svg>
          {text}
        </li>
      ))}
    </ul>
  );
}

/** Each kind differs by shape, not only colour: a note is a filled dot, a concept a diamond, a tag a square, a ghost a dashed ring. */
function NodeShape({ kind, radius: r, emphasis }: { kind: GraphNode["kind"]; radius: number; emphasis: boolean }) {
  switch (kind) {
    case "note":
      return <circle r={r} className={emphasis ? "fill-foreground" : "fill-muted-foreground"} />;
    case "concept":
      return <polygon points={`0,${-r * 1.2} ${r * 1.2},0 0,${r * 1.2} ${-r * 1.2},0`} className={cn("stroke-foreground stroke-[1.5]", emphasis ? "fill-foreground" : "fill-card")} />;
    case "tag":
      return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={1.5} className={cn("stroke-muted-foreground stroke-[1.5]", emphasis ? "fill-muted-foreground" : "fill-muted")} />;
    case "ghost":
      return <circle r={r} className={cn("fill-card stroke-muted-foreground stroke-[1.5]", emphasis && "stroke-foreground")} strokeDasharray="2 2" />;
  }
}

/** The node nearest `from` in an arrow key's direction, preferring nodes straight ahead over those to the side. */
export function nodeInDirection(layout: NotesGraphLayout, from: number, key: string): number | undefined {
  const [dx, dy] = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, [number, number]>)[key] ?? [0, 0];
  if (dx === 0 && dy === 0) return undefined;
  const origin = layout.nodes[from]!;
  let best: number | undefined;
  let bestScore = Infinity;
  layout.nodes.forEach((node, i) => {
    const x = node.x - origin.x;
    const y = node.y - origin.y;
    const ahead = x * dx + y * dy;
    if (i === from || ahead <= 0) return;
    const aside = Math.abs(x * dy - y * dx);
    const score = ahead + aside * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function NotesGraphDrawing({
  view,
  layout,
  selected,
  onSelect,
  onActivate,
}: {
  view: NoteGraphView;
  layout: NotesGraphLayout;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  onActivate: (node: GraphNode) => void;
}) {
  const indexOf = useMemo(() => new Map(view.nodes.map((n, i) => [n.id, i])), [view]);
  const neighbours = useMemo(() => {
    const all = view.nodes.map(() => new Set<number>());
    for (const [a, b] of layout.edges) {
      all[a]!.add(b);
      all[b]!.add(a);
    }
    return all;
  }, [view, layout]);

  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const fit = () => {
    const box = scroller.current;
    if (!box || box.clientWidth === 0) return 1;
    return clampZoom(Math.min(1, box.clientWidth / layout.width, box.clientHeight / layout.height));
  };
  // A new view opens fitted to the box, and centred on its focus or selection when it's larger than that.
  const selectedIndex = selected === undefined ? undefined : indexOf.get(selected);
  const centre = (index: number | undefined, z: number) => {
    const box = scroller.current;
    if (!box) return;
    const node = index === undefined ? undefined : layout.nodes[index];
    box.scrollLeft = node ? node.x * z - box.clientWidth / 2 : (layout.width * z - box.clientWidth) / 2;
    box.scrollTop = node ? node.y * z - box.clientHeight / 2 : (layout.height * z - box.clientHeight) / 2;
  };
  useLayoutEffect(() => {
    const z = fit();
    setZoom(z);
    requestAnimationFrame(() => centre(view.focus ? indexOf.get(view.focus) : undefined, z));
  }, [layout]);
  const zoomTo = (z: number) => {
    const next = clampZoom(z);
    setZoom(next);
    requestAnimationFrame(() => centre(selectedIndex, next));
  };

  // One tab stop for the whole drawing: arrow keys move between nodes, by where they're drawn.
  const [active, setActive] = useState<number>();
  const current = active !== undefined && active < view.nodes.length ? active : (selectedIndex ?? 0);
  useEffect(() => setActive(undefined), [view]);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const moveTo = (index: number) => {
    setActive(index);
    const button = buttons.current.get(index);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.key === "Escape") {
      if (selected !== undefined) {
        e.stopPropagation();
        onSelect(undefined);
      }
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      moveTo(view.focus ? (indexOf.get(view.focus) ?? 0) : 0);
      return;
    }
    const next = nodeInDirection(layout, index, e.key);
    if (e.key.startsWith("Arrow")) e.preventDefault();
    if (next !== undefined) moveTo(next);
  };

  // Drag the background to pan.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const onPointerDown = (e: PointerEvent) => {
    const box = scroller.current;
    if (!box || e.button !== 0 || (e.target as Element).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const box = scroller.current;
    if (!box || !drag.current) return;
    box.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    box.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => (drag.current = undefined);

  const [hovered, setHovered] = useState<number>();
  const emphasised = new Set<number>();
  for (const i of [selectedIndex, hovered, active]) {
    if (i === undefined) continue;
    emphasised.add(i);
    if (i === selectedIndex) for (const j of neighbours[i] ?? []) emphasised.add(j);
  }
  const allLabels = view.nodes.length <= ALL_LABELS_NODES || zoom >= 1.5;
  const fading = selectedIndex !== undefined;
  const hit = (r: number) => Math.max(MIN_HIT_PX, r * 2 * zoom);
  const description = useId();
  const activeNode = view.nodes[current];

  if (view.nodes.length === 0) return <div className="flex-1" />;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="bg-background min-h-64 flex-1 cursor-grab overflow-auto active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="notes-graph-scroll"
      >
        <div className="relative" style={{ width: layout.width * zoom, height: layout.height * zoom }} data-testid="notes-graph-canvas" data-zoom={zoom.toFixed(3)}>
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="absolute inset-0 size-full" aria-hidden="true">
            <defs>
              <marker id={`${description}-arrow`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            {layout.edges.map(([a, b], i) => {
              const edge = view.edges[i]!;
              const from = layout.nodes[a]!;
              const to = layout.nodes[b]!;
              const lit = selectedIndex !== undefined && (a === selectedIndex || b === selectedIndex);
              // Stop short of the target's rim so an arrowhead shows.
              const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
              const end = edge.kind === "prerequisite" ? to.radius + 2 : 0;
              return (
                <line
                  key={i}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x - ((to.x - from.x) / length) * end}
                  y2={to.y - ((to.y - from.y) / length) * end}
                  className={cn(lit ? "stroke-foreground" : "stroke-muted-foreground", fading && !lit && "opacity-25")}
                  strokeOpacity={lit ? 1 : edge.kind === "tag" || edge.kind === "concept" ? 0.45 : 0.7}
                  strokeWidth={lit ? 1.6 : 1}
                  strokeDasharray={edge.kind === "tag" || edge.kind === "concept" ? "3 3" : undefined}
                  markerEnd={edge.kind === "prerequisite" ? `url(#${description}-arrow)` : undefined}
                  data-testid="notes-graph-edge"
                  data-kind={edge.kind}
                />
              );
            })}
            {layout.nodes.map((node, i) => (
              <g key={node.id} transform={`translate(${node.x} ${node.y})`} className={cn(fading && !emphasised.has(i) && "opacity-35")}>
                {(i === selectedIndex || (view.focus === node.id && selectedIndex === undefined)) && <circle r={node.radius + 4} className="fill-none stroke-foreground stroke-[1.5]" />}
                <NodeShape kind={view.nodes[i]!.kind} radius={node.radius} emphasis={emphasised.has(i)} />
              </g>
            ))}
          </svg>
          {/* Labels are HTML over the SVG, as in the graph artifact, and keep their size at any zoom. */}
          <div className="pointer-events-none absolute inset-0 text-[11px] leading-tight" aria-hidden="true">
            {layout.nodes.map((node, i) =>
              allLabels || emphasised.has(i) || view.focus === node.id ? (
                <span
                  key={node.id}
                  className={cn(
                    "bg-background/80 absolute max-w-40 -translate-x-1/2 truncate rounded-sm px-0.5",
                    emphasised.has(i) ? "text-foreground font-medium" : "text-muted-foreground",
                    view.nodes[i]!.kind === "ghost" && "italic",
                    fading && !emphasised.has(i) && "opacity-50",
                  )}
                  style={{ left: node.x * zoom, top: node.y * zoom + node.radius * zoom + 2 }}
                  data-testid="notes-graph-label"
                >
                  {view.nodes[i]!.label}
                </span>
              ) : null,
            )}
          </div>
          <div role="group" aria-label="Notes graph. Arrow keys move between nodes by where they're drawn; Enter opens a note." aria-describedby={description} className="absolute inset-0">
            {layout.nodes.map((node, i) => {
              const data = view.nodes[i]!;
              const size = hit(node.radius);
              return (
                <button
                  key={node.id}
                  ref={(el) => {
                    if (el) buttons.current.set(i, el);
                    else buttons.current.delete(i);
                  }}
                  type="button"
                  tabIndex={i === current ? 0 : -1}
                  aria-label={nodeName(data, neighbours[i]!.size)}
                  aria-pressed={i === selectedIndex}
                  // The selected node stays on top of neighbours whose hit areas overlap it when zoomed out.
                  className={cn("focus-visible:ring-ring/60 absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full outline-none focus-visible:ring-[3px]", i === selectedIndex && "z-10")}
                  style={{ left: node.x * zoom, top: node.y * zoom, width: size, height: size }}
                  onClick={() => {
                    setActive(i);
                    onActivate(data);
                  }}
                  onFocus={() => setActive(i)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  onPointerEnter={() => setHovered(i)}
                  onPointerLeave={() => setHovered((h) => (h === i ? undefined : h))}
                  data-testid="notes-graph-node"
                  data-node={node.id}
                  data-kind={data.kind}
                />
              );
            })}
          </div>
        </div>
      </div>
      <p id={description} className="sr-only" aria-live="polite" data-testid="notes-graph-neighbours">
        {activeNode && active !== undefined ? connectionsText(view, neighbours[current]!, activeNode) : ""}
      </p>
      <div className="bg-card/90 absolute right-3 bottom-3 flex gap-1 rounded-md border p-1 shadow-xs" role="group" aria-label="Zoom">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoomTo(zoom / ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>
          <Minus />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Fit to the window" onClick={() => zoomTo(fit())}>
          <Maximize />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomTo(zoom * ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>
          <Plus />
        </Button>
      </div>
    </div>
  );
}

/** What a node connects to, read out when the keyboard reaches it: the drawing shows this only by lines. */
function connectionsText(view: NoteGraphView, neighbours: Set<number>, node: GraphNode) {
  const names = [...neighbours].map((j) => view.nodes[j]!).map((n) => (n.kind === "ghost" ? `${n.label} (unresolved)` : n.label));
  const shown = names.slice(0, 12);
  const rest = names.length - shown.length;
  if (names.length === 0) return `${node.label} connects to nothing drawn.`;
  return `${node.label} connects to ${shown.join(", ")}${rest > 0 ? ` and ${plural(rest, "more")}` : ""}.`;
}

/** One note, read-only: notes change only when their vault is imported again. */
function NoteReader({ noteId, onOpenChange, onCentre }: { noteId?: string; onOpenChange: (open: boolean) => void; onCentre: (id: string) => void }) {
  const [note, setNote] = useState<{ id: string; view?: NoteView; error?: string }>();
  useEffect(() => {
    if (!noteId) return;
    let stale = false;
    setNote({ id: noteId });
    void getNote(noteId).then((result) => {
      if (!stale) setNote(result.ok ? { id: noteId, view: result.value } : { id: noteId, error: result.error });
    });
    return () => {
      stale = true;
    };
  }, [noteId]);
  const shown = note?.view;
  return (
    <Sheet open={Boolean(noteId)} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
        data-testid="note-reader"
        // Back to the note's node, which a click doesn't focus in every browser.
        onCloseAutoFocus={(e) => {
          const node = note && document.querySelector<HTMLElement>(`[data-testid="notes-graph-node"][data-node="${CSS.escape(note.id)}"]`);
          if (!node) return;
          e.preventDefault();
          node.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-heading wrap-anywhere">{shown?.title ?? "Note"}</SheetTitle>
          <SheetDescription className="wrap-anywhere">{shown ? `${shown.path} · read-only` : note?.error ? "Couldn't open this note." : "Loading…"}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          {note?.error && <p className="text-destructive text-sm">{note.error}</p>}
          {!shown && !note?.error && <Spinner aria-label="Loading the note" />}
          {shown && (
            <>
              {(shown.tags.length > 0 || shown.aliases.length > 0) && (
                <div className="flex flex-wrap gap-1">
                  {shown.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      #{tag}
                    </Badge>
                  ))}
                  {shown.aliases.length > 0 && <span className="text-muted-foreground text-xs">Also called {shown.aliases.join(", ")}</span>}
                </div>
              )}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onCentre(shown.id)}>
                Show the graph around this note
              </Button>
              {/* Plain text: a vault is hostile input (ADR-010), and a note can be a million characters long. */}
              <div className="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap" data-testid="note-body">
                {shown.body}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
