import type { NoteGraph } from "@mivra/protocol";
import { noteKey } from "./parse.js";

/** How many trailing folders a link like `[[folder/Note]]` can name and still resolve by suffix. */
export const MAX_SUFFIX_SEGMENTS = 8;

export interface GraphNoteInput {
  id: string;
  path: string;
  title: string;
  titleKey: string;
  aliases: string[];
  tags: string[];
}

export interface GraphLinkInput {
  noteId: string;
  target: string;
  kind: "link" | "embed";
}

/**
 * The normalised path key and trailing folder-suffix keys for a note path (without `.md`), matching
 * how Obsidian resolves folder-qualified links such as `[[folder/Note]]`.
 */
export function pathSuffixKeys(path: string): { pathKey: string; suffixes: string[] } {
  const pathKey = noteKey(path.replace(/\.md$/i, ""));
  const segments = pathKey.split("/");
  const suffixes: string[] = [];
  // Only the last few folders: a hostile path of hundreds of tiny folders would otherwise mean hundreds of keys.
  for (let from = Math.max(1, segments.length - MAX_SUFFIX_SEGMENTS); from < segments.length; from++) {
    suffixes.push(segments.slice(from).join("/"));
  }
  return { pathKey, suffixes };
}

/**
 * Resolves each link to a note as Obsidian does, ignoring case: a target with a folder matches that path (or
 * one ending in it), and a bare name matches a note's title, then an alias. When several notes share a title,
 * the one with the shortest path wins. Anything else stays unresolved.
 */
export function resolveGraph(graph: { notes: GraphNoteInput[]; links: GraphLinkInput[] }): NoteGraph {
  const byPath = new Map<string, string>();
  /** Every trailing part of every path (`b/c` and `c` for `a/b/c`), so a folder link needs no scan of all notes. */
  const bySuffix = new Map<string, string>();
  const byTitle = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const shortestFirst = [...graph.notes].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  for (const note of shortestFirst) {
    const { pathKey, suffixes } = pathSuffixKeys(note.path);
    byPath.set(pathKey, note.id);
    for (const suffix of suffixes) {
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, note.id);
    }
    if (!byTitle.has(note.titleKey)) byTitle.set(note.titleKey, note.id);
    for (const alias of note.aliases) if (!byAlias.has(alias)) byAlias.set(alias, note.id);
  }
  const resolve = (target: string): string | null => {
    const key = noteKey(target);
    if (key.includes("/")) return byPath.get(key) ?? bySuffix.get(key) ?? null;
    return byTitle.get(key) ?? byAlias.get(key) ?? null;
  };
  return {
    notes: graph.notes.map(({ id, path, title, tags }) => ({ id, path, title, tags })),
    links: graph.links.map((link) => ({ from: link.noteId, to: resolve(link.target), target: link.target, kind: link.kind })),
  };
}
