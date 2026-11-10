import { conceptKey } from "../runtime/learner-context.js";
import type { KnowledgeStore } from "../store/knowledge-store.js";
import type { NoteStore } from "../store/note-store.js";
import type { SessionStore } from "../store/session-store.js";

/**
 * What Mivra knows, as Markdown files to drop into the learner's own Obsidian vault (ADR-014 step 5, issue #64):
 * a `Mivra/` folder with `Concepts/` and `Memories/`. Only what Mivra drew or was told, never the learner's notes,
 * which concept notes link to by title. Every file says `mivra: generated` in its frontmatter, so importing the vault
 * again skips them (see isMivraGenerated in parse.ts) and doesn't feed Mivra its own output.
 *
 * Names and text come from the model and the learner, so file names are sanitised and made unique, frontmatter
 * values are quoted, and text is escaped so it can't open links, embeds or HTML.
 */

export const EXPORT_FOLDER = "Mivra";

export interface ExportConcept {
  id: string;
  name: string;
  /** The notes it was drawn from. */
  notes: string[];
}

export interface ExportEdge {
  from: string;
  to: string;
  kind: "prerequisite" | "related";
}

export interface ExportNote {
  id: string;
  title: string;
  titleKey: string;
  path: string;
}

/** A memory that isn't held: held ones (ADR-009) never reach the export, only their count. */
export interface ExportMemory {
  id: string;
  kind: "goal" | "preference" | "misconception" | "known";
  text: string;
  concept: string | null;
  basis: "wrong_answer" | "chat" | "import";
  noteId: string | null;
  createdAt: Date;
  editedAt: Date | null;
}

export interface ExportInput {
  concepts: ExportConcept[];
  edges: ExportEdge[];
  /** Every imported note, so a title shared by two notes can be told apart by its path. */
  notes: ExportNote[];
  memories: ExportMemory[];
  /** How many memories were left out because they're held until a check is answered. */
  held: number;
  exportedAt: Date;
}

export interface ExportFile {
  path: string;
  text: string;
}

/** Longest file name, before `.md`: in characters, and in UTF-8 bytes, since most file systems allow 255. */
const MAX_NAME_CHARS = 80;
const MAX_NAME_BYTES = 180;
/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * A file name (without `.md`) safe on Windows, macOS and Linux and usable in an Obsidian link: no path separators,
 * no characters Windows or Obsidian links refuse, no control or invisible formatting characters, no leading dot,
 * no `..`, no trailing dot or space, not a reserved device name, and capped in length.
 */
export function safeFileName(raw: string, fallback = "Untitled"): string {
  let name = raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  let chars = 0;
  let bytes = 0;
  let cut = "";
  for (const char of name) {
    const size = Buffer.byteLength(char, "utf8");
    if (chars + 1 > MAX_NAME_CHARS || bytes + size > MAX_NAME_BYTES) break;
    cut += char;
    chars++;
    bytes += size;
  }
  name = cut.replace(/[\s.]+$/g, "");
  if (!name) name = fallback;
  if (RESERVED.test(name.split(".")[0]!.trim())) name = `_${name}`;
  return name;
}

/** Makes names unique within a folder, ignoring case as macOS and Windows do: `Name`, `Name 2`, `Name 3`. */
function uniqueNames() {
  const taken = new Set<string>();
  return (name: string) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };
}

/** Text as one line of Markdown that renders as written: no links, embeds, tags, HTML, maths or formatting. */
export function escapeInline(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#|$~=^%]/g, (c) => `\\${c}`);
}

/** A YAML double-quoted string (JSON is valid YAML), without characters some YAML readers treat as line breaks. */
function yamlString(text: string): string {
  return JSON.stringify(text.replace(/[\p{Cc}\u0085\u2028\u2029]/gu, " "));
}

/** Text for a link's display part, after `|`: nothing that could end the link early. */
const linkLabel = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}[\]|]/gu, " ").replace(/\s+/g, " ").trim() || "untitled";

/** A wiki link can't hold these; a note named with them is named in plain text instead. */
const UNLINKABLE = /[[\]|#^\p{Cc}]/u;

const date = (d: Date) => d.toISOString().slice(0, 10);

function frontmatter(fields: [string, string | number | null | undefined][]): string {
  const lines = fields.filter((f): f is [string, string | number] => f[1] !== null && f[1] !== undefined).map(([k, v]) => `${k}: ${v}`);
  return `---\nmivra: generated\n${lines.join("\n")}\n---\n`;
}

const kindLabel: Record<ExportMemory["kind"], string> = { goal: "Goal", preference: "Preference", misconception: "Misconception", known: "Known" };
const kindHeading: Record<ExportMemory["kind"], string> = { goal: "Goals", preference: "Preferences", misconception: "Misconceptions", known: "Known from your notes" };
const basisLabel: Record<ExportMemory["basis"], string> = { wrong_answer: "a wrong answer to a check", chat: "what you said in chat", import: "your notes" };

/** The vault's files, in a stable order: the index, then concepts, then memories. */
export function buildVault(input: ExportInput): ExportFile[] {
  const conceptNames = uniqueNames();
  const memoryNames = uniqueNames();
  const conceptFile = new Map<string, string>();
  const conceptByKey = new Map<string, ExportConcept>();
  for (const concept of input.concepts) {
    conceptFile.set(concept.id, conceptNames(safeFileName(concept.name, "Concept")));
    conceptByKey.set(conceptKey(concept.name), concept);
  }
  const conceptLink = (concept: ExportConcept) => `[[${EXPORT_FOLDER}/Concepts/${conceptFile.get(concept.id)}|${linkLabel(concept.name)}]]`;

  // A title shared by two notes would link to whichever Obsidian finds first, so those link by path instead.
  const titleCount = new Map<string, number>();
  for (const note of input.notes) titleCount.set(note.titleKey, (titleCount.get(note.titleKey) ?? 0) + 1);
  const notesById = new Map(input.notes.map((n) => [n.id, n]));
  const noteLink = (id: string): string | null => {
    const note = notesById.get(id);
    if (!note) return null;
    const target = (titleCount.get(note.titleKey) ?? 0) > 1 ? note.path.replace(/\.md$/i, "") : note.title;
    return UNLINKABLE.test(target) ? escapeInline(note.title) : `[[${target}]]`;
  };

  const memoryFile = new Map<string, string>();
  for (const memory of input.memories) {
    memoryFile.set(memory.id, memoryNames(safeFileName(`${kindLabel[memory.kind]} - ${memory.text}`, kindLabel[memory.kind])));
  }
  const memoryLink = (memory: ExportMemory) => `[[${EXPORT_FOLDER}/Memories/${memoryFile.get(memory.id)}|${linkLabel(memory.text)}]]`;
  const memoryConcept = (memory: ExportMemory) => (memory.concept ? conceptByKey.get(conceptKey(memory.concept)) : undefined);

  const files: ExportFile[] = [];
  files.push({ path: `${EXPORT_FOLDER}/Mivra.md`, text: indexNote(input, conceptLink, memoryLink) });

  const byId = new Map(input.concepts.map((c) => [c.id, c]));
  for (const concept of input.concepts) {
    const builds = input.edges.filter((e) => e.kind === "prerequisite" && e.to === concept.id).map((e) => e.from);
    const leads = input.edges.filter((e) => e.kind === "prerequisite" && e.from === concept.id).map((e) => e.to);
    const related = input.edges.filter((e) => e.kind === "related" && (e.from === concept.id || e.to === concept.id)).map((e) => (e.from === concept.id ? e.to : e.from));
    const links = (ids: string[]) => [...new Set(ids)].flatMap((id) => (byId.has(id) ? [`- ${conceptLink(byId.get(id)!)}`] : []));
    const sourceLinks = [...new Set(concept.notes.map(noteLink).filter((l): l is string => l !== null))].map((l) => `- ${l}`);
    const memories = input.memories.filter((m) => memoryConcept(m)?.id === concept.id).map((m) => `- ${memoryLink(m)}`);
    const sections: [string, string[]][] = [
      ["From your notes", sourceLinks],
      ["Builds on", links(builds)],
      ["Leads to", links(leads)],
      ["Related", links(related)],
      ["Memories", memories],
    ];
    const text =
      frontmatter([
        ["type", "concept"],
        ["name", yamlString(concept.name)],
        ["tags", "[mivra/concept]"],
      ]) +
      `\n# ${escapeInline(concept.name)}\n\nA concept Mivra drew from your notes.\n` +
      sections
        .filter(([, lines]) => lines.length > 0)
        .map(([heading, lines]) => `\n## ${heading}\n\n${lines.join("\n")}\n`)
        .join("");
    files.push({ path: `${EXPORT_FOLDER}/Concepts/${conceptFile.get(concept.id)}.md`, text });
  }

  for (const memory of input.memories) {
    const concept = memoryConcept(memory);
    const source = memory.noteId ? noteLink(memory.noteId) : null;
    const sourceNote = memory.noteId ? notesById.get(memory.noteId) : undefined;
    const details = [
      memory.concept ? `- Concept: ${concept ? conceptLink(concept) : escapeInline(memory.concept)}` : null,
      `- From ${basisLabel[memory.basis]}${source ? `: ${source}` : ""}`,
    ].filter(Boolean);
    const text =
      frontmatter([
        ["type", "memory"],
        ["kind", memory.kind],
        ["basis", memory.basis],
        ["concept", memory.concept ? yamlString(memory.concept) : null],
        ["source", source && source.startsWith("[[") ? yamlString(source) : sourceNote ? yamlString(sourceNote.title) : null],
        ["created", date(memory.createdAt)],
        ["edited", memory.editedAt ? date(memory.editedAt) : null],
        ["tags", `[mivra/memory, mivra/${memory.kind}]`],
      ]) + `\n${escapeInline(memory.text)}\n\n${details.join("\n")}\n`;
    files.push({ path: `${EXPORT_FOLDER}/Memories/${memoryFile.get(memory.id)}.md`, text });
  }
  return files;
}

function indexNote(input: ExportInput, conceptLink: (c: ExportConcept) => string, memoryLink: (m: ExportMemory) => string): string {
  const parts = [
    frontmatter([
      ["type", "index"],
      ["exported", date(input.exportedAt)],
    ]),
    `\n# What Mivra knows\n\nExported from Mivra on ${date(input.exportedAt)}. Mivra keeps its own copy: editing these files doesn't change it, and importing this folder again skips them.\n`,
  ];
  if (input.concepts.length > 0) parts.push(`\n## Concepts\n\n${input.concepts.map((c) => `- ${conceptLink(c)}`).join("\n")}\n`);
  for (const kind of ["goal", "misconception", "preference", "known"] as const) {
    const memories = input.memories.filter((m) => m.kind === kind);
    if (memories.length > 0) parts.push(`\n## ${kindHeading[kind]}\n\n${memories.map((m) => `- ${memoryLink(m)}`).join("\n")}\n`);
  }
  if (input.held > 0) {
    parts.push(`\n${input.held === 1 ? "1 memory is" : `${input.held} memories are`} left out for now: each could give away a check you haven't answered yet.\n`);
  }
  if (input.concepts.length === 0 && input.memories.length === 0 && input.held === 0) parts.push("\nMivra doesn't know anything yet.\n");
  return parts.join("");
}

/** Reads what to export from the stores and builds the vault's files. Held memories are counted, never read out. */
export function exportVault(deps: { store: SessionStore; knowledge: KnowledgeStore; notes: NoteStore; checkKinds: string[]; exportedAt: Date }): ExportFile[] {
  const graph = deps.knowledge.conceptGraph();
  const listed = deps.store.listMemoriesForLearner(deps.checkKinds);
  return buildVault({
    concepts: graph.concepts,
    edges: graph.edges,
    notes: deps.notes.noteIndex(),
    memories: listed.filter((m) => !m.held),
    held: listed.filter((m) => m.held).length,
    exportedAt: deps.exportedAt,
  });
}
