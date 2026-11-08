import { posix } from "node:path";

/**
 * Reads the structure out of an Obsidian note without a model (ADR-014): title, aliases, tags, links and chunks
 * under their headings. Notes are hostile input, so every pattern here runs in linear time and every list is capped.
 */

/** Most distinct links and tags kept from one note; a note listing more is truncated. */
export const MAX_LINKS_PER_NOTE = 1000;
export const MAX_TAGS_PER_NOTE = 100;
const MAX_TAG_CHARS = 100;
/** Small enough that a turn's budget can hold several pieces from different notes, as for documents (ADR-010). */
const MAX_CHUNK_CHARS = 1200;
const MAX_TARGET_CHARS = 300;
const MAX_ALIASES = 50;
/** Headings past this many in one note stay plain text, so a note of nothing but headings can't make 250,000 sections. */
const MAX_SECTIONS = 2000;
/** A heading is copied into each chunk under it, so both it and its path are capped: a 100 KB heading over 2,000 subsections would otherwise be copied 2,000 times. */
const MAX_HEADING_CHARS = 120;
const MAX_HEADING_PATH_CHARS = 300;
/** Frontmatter beyond this many lines isn't read, so a note that opens with `---` and never closes it stays text. */
const MAX_FRONTMATTER_LINES = 500;

export interface ParsedLink {
  target: string;
  kind: "link" | "embed";
}

export interface ParsedNote {
  title: string;
  aliases: string[];
  tags: string[];
  links: ParsedLink[];
  chunks: { seq: number; heading: string | null; text: string }[];
  /** Whether links or tags were dropped for being over the per-note limits. */
  truncated: boolean;
}

/** How titles, aliases and link targets are compared: Obsidian resolves links ignoring case. */
export function noteKey(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** `[a, b]`, `a, b` or a single value. Obsidian accepted commas or spaces between tags in older vaults. */
function inlineList(value: string, splitSpaces: boolean): string[] {
  const inner = value.trim().replace(/^\[(.*)\]$/, "$1");
  return inner
    .split(splitSpaces ? /[,\s]+/ : /,/)
    .map(unquote)
    .filter(Boolean);
}

/**
 * The few frontmatter keys Mivra uses: tags and aliases. Only a small YAML subset is read, by hand, so no YAML
 * parser (and none of its anchors or aliases) ever sees learner text. Anything else is ignored.
 */
function readFrontmatter(lines: string[]): { tags: string[]; aliases: string[] } {
  const found = { tags: [] as string[], aliases: [] as string[] };
  let current: "tags" | "aliases" | undefined;
  for (const line of lines) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && current) {
      const value = unquote(item[1]!);
      if (value) found[current].push(value);
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      if (!/^\s/.test(line)) current = undefined;
      continue;
    }
    const key = pair[1]!.toLowerCase();
    current = key === "tags" || key === "tag" ? "tags" : key === "aliases" || key === "alias" ? "aliases" : undefined;
    if (current && pair[2]!.trim()) found[current].push(...inlineList(pair[2]!, current === "tags"));
  }
  return found;
}

/** Splits off a frontmatter block: `---` on the first line, closed by `---` or `...` on its own line. */
function splitFrontmatter(text: string): { frontmatter: string[]; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: [], body: text };
  let start = 4;
  for (let line = 0; line < MAX_FRONTMATTER_LINES; line++) {
    const end = text.indexOf("\n", start);
    const current = text.slice(start, end < 0 ? undefined : end);
    if (current === "---" || current === "...") {
      return { frontmatter: text.slice(4, start).split("\n"), body: end < 0 ? "" : text.slice(end + 1) };
    }
    if (end < 0) break;
    start = end + 1;
  }
  return { frontmatter: [], body: text };
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const WIKI_LINK = /(!?)\[\[([^[\]\n]{1,1000})\]\]/g;
// The text excludes `[`, so a run of brackets can't make each one rescan the line.
const MD_LINK = /\[[^[\]\n]{0,1000}\]\(([^()\s]{1,1000})\)/g;
const INLINE_CODE = /`[^`\n]*`/g;
// A tag starts after whitespace, an opening bracket or a comma, and must contain something other than digits.
const TAG = /(?:^|[\s(,])#([\p{L}\p{N}_/-]+)/gu;

/** The first character after up to three spaces of indent: only these lines can open a fence or a heading. */
function markerChar(line: string): string | undefined {
  let at = 0;
  while (at < 3 && line[at] === " ") at++;
  return line[at];
}

/** A heading's text without a closing run of `#`, trimmed by hand: a regex for it backtracks on long runs of spaces. */
function headingText(raw: string): string {
  let end = raw.length;
  while (end > 0 && /\s/.test(raw[end - 1]!)) end--;
  let hashes = end;
  while (hashes > 0 && raw[hashes - 1] === "#") hashes--;
  if (hashes < end && (hashes === 0 || /\s/.test(raw[hashes - 1]!))) end = hashes;
  return raw.slice(0, end).trim();
}

/** The target of a wiki link, without `|display`, `#heading` or `^block`, and without a `.md` extension. */
function wikiTarget(inner: string): { target: string; attachment: boolean } | undefined {
  const raw = inner.split("|")[0]!.split("#")[0]!.split("^")[0]!.trim();
  // Decided before `.md` comes off, so `[[Version 1.0.md]]` is a note, not a `.0` attachment.
  const attachment = !/\.md$/i.test(raw) && isAttachment(raw);
  const target = raw.replace(/\.md$/i, "");
  return target && target.length <= MAX_TARGET_CHARS ? { target, attachment } : undefined;
}

/** A Markdown link to another note in the vault, relative to this note's folder, as a vault path without `.md`. */
function markdownTarget(href: string, notePath: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#")[0]!);
  } catch {
    return undefined;
  }
  if (!/\.md$/i.test(decoded)) return undefined;
  const joined = decoded.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(notePath), decoded);
  const normal = posix.normalize(joined);
  const target = (normal.startsWith("../") ? posix.basename(normal) : normal).replace(/\.md$/i, "");
  return target && target !== "." && target.length <= MAX_TARGET_CHARS ? target : undefined;
}

/** Attachments (images, PDFs) embedded with `![[...]]` aren't notes; only extensionless or `.md` targets are. */
const ATTACHMENT = /\.(png|jpe?g|gif|bmp|svg|webp|avif|heic|tiff?|mp3|wav|m4a|ogg|flac|3gp|webm|mp4|mov|mkv|ogv|pdf|canvas|base)$/i;
const isAttachment = (target: string) => ATTACHMENT.test(target);

/**
 * Splits a long section at a line end in the second half of each window, else at the last space, else mid-word.
 * It works by index and looks back at most one window per piece, so it stays linear on a 1 MB line.
 */
function splitLong(text: string, max: number): string[] {
  const pieces: string[] = [];
  const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t";
  let start = 0;
  while (start < text.length && isSpace(text[start])) start++;
  while (text.length - start > max) {
    let newline = -1;
    let space = -1;
    for (let at = start + max; at > start && newline < 0; at--) {
      if (text[at] === "\n") newline = at;
      else if (space < 0 && text[at] === " ") space = at;
    }
    const cut = newline > start + max / 2 ? newline : space > start ? space : newline > start ? newline : start + max;
    const piece = text.slice(start, cut).trim();
    if (piece) pieces.push(piece);
    start = cut;
    while (start < text.length && isSpace(text[start])) start++;
  }
  const rest = text.slice(start).trim();
  if (rest) pieces.push(rest);
  return pieces;
}

/** Packs consecutive sections into chunks of about MAX_CHUNK_CHARS, so a note of many tiny headings stays a few chunks. */
function packChunks(sections: { heading: string | null; lines: string[] }[]) {
  const chunks: { seq: number; heading: string | null; text: string }[] = [];
  let pending: { heading: string | null; text: string } | undefined;
  const flush = () => {
    if (pending?.text) chunks.push({ seq: chunks.length, ...pending });
    pending = undefined;
  };
  for (const section of sections) {
    // A heading with nothing under it, as in an outline, still says what the note covers, so it's kept as text.
    const body = section.lines.join("\n").trim();
    const text = body || (section.heading?.split(" > ").at(-1) ?? "");
    if (!text) continue;
    if (text.length > MAX_CHUNK_CHARS) {
      flush();
      for (const piece of splitLong(text, MAX_CHUNK_CHARS)) chunks.push({ seq: chunks.length, heading: section.heading, text: piece });
      continue;
    }
    if (pending && pending.text.length + text.length + 2 <= MAX_CHUNK_CHARS) {
      // The heading of a section merged into an earlier one stays in the text, so search still finds it.
      // A heading with no text of its own is written once, as its whole path.
      pending.text += `\n\n${!body ? section.heading : `${section.heading && section.heading !== pending.heading ? `${section.heading}\n` : ""}${text}`}`;
    } else {
      flush();
      pending = { heading: section.heading, text };
    }
  }
  flush();
  return chunks;
}

/** Parses one note. `path` is its vault path, which gives its title (the file name, as in Obsidian). */
export function parseNote(path: string, raw: string): ParsedNote {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const { frontmatter, body } = splitFrontmatter(text);
  const meta = readFrontmatter(frontmatter);
  const title = posix.basename(path).replace(/\.md$/i, "");

  let truncated = false;
  const links = new Map<string, ParsedLink>();
  const addLink = (target: string, kind: ParsedLink["kind"]) => {
    const key = `${kind}:${target}`;
    if (links.has(key)) return;
    if (links.size >= MAX_LINKS_PER_NOTE) truncated = true;
    else links.set(key, { target, kind });
  };
  const tags = new Set<string>();
  const addTag = (raw: string) => {
    const tag = raw.replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
    if (!tag || tags.has(tag) || tag.length > MAX_TAG_CHARS || /^[\d/]+$/.test(tag) || !/^[\p{L}\p{N}_/-]+$/u.test(tag)) return;
    if (tags.size >= MAX_TAGS_PER_NOTE) truncated = true;
    else tags.add(tag);
  };
  for (const tag of meta.tags) addTag(tag);

  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  const headingPath: string[] = [];
  // Lines outside code fences, where links and tags count. Each pattern then runs once over all of them, not per line.
  const prose: string[] = [];
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const first = markerChar(line);
    const fenceMatch = first === "`" || first === "~" ? FENCE.exec(line) : null;
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = undefined;
      sections.at(-1)!.lines.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      sections.at(-1)!.lines.push(line);
      continue;
    }
    prose.push(line);
    const heading = first === "#" && sections.length < MAX_SECTIONS ? HEADING.exec(line) : null;
    if (heading) {
      const level = heading[1]!.length;
      headingPath.length = Math.min(headingPath.length, level - 1);
      headingPath.push(headingText(heading[2] ?? "").slice(0, MAX_HEADING_CHARS));
      sections.push({ heading: headingPath.filter(Boolean).join(" > ").slice(0, MAX_HEADING_PATH_CHARS) || null, lines: [] });
    } else {
      sections.at(-1)!.lines.push(line);
    }
  }

  const proseText = prose.join("\n").replace(INLINE_CODE, " ");
  // Notes repeat links; each distinct spelling is parsed once.
  const seenLinks = new Set<string>();
  for (const match of proseText.matchAll(WIKI_LINK)) {
    if (seenLinks.has(match[0])) continue;
    seenLinks.add(match[0]);
    const parsed = wikiTarget(match[2]!);
    if (!parsed) continue;
    const embed = match[1] === "!";
    if (embed && parsed.attachment) continue;
    addLink(parsed.target, embed ? "embed" : "link");
  }
  for (const match of proseText.matchAll(MD_LINK)) {
    const target = markdownTarget(match[1]!, path);
    if (target) addLink(target, "link");
  }
  for (const match of proseText.matchAll(TAG)) addTag(match[1]!);

  const aliases = [...new Set(meta.aliases.map((a) => a.slice(0, MAX_TARGET_CHARS)))].slice(0, MAX_ALIASES);
  return { title, aliases, tags: [...tags], links: [...links.values()], chunks: packChunks(sections), truncated };
}
