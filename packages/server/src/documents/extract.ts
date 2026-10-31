import { posix } from "node:path";
import { getResolvedPDFJS } from "unpdf";
import yauzl from "yauzl";

/**
 * Text extraction for untrusted PDF and PPTX files (ADR-010). This runs inside a worker thread (see
 * extract-in-worker.ts), which supplies the timeout and memory limits this code can't enforce itself.
 */

export type DocumentErrorCode = "too_large" | "wrong_type" | "no_text" | "encrypted" | "corrupt" | "too_complex" | "timeout" | "failed";

/** A failure whose message is safe and useful to show the learner. */
export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtractedPage {
  /** 1-based page or slide number. */
  page: number;
  text: string;
}

export interface ExtractedDocument {
  kind: "pdf" | "pptx";
  pageCount: number;
  /** Only the pages that have text. */
  pages: ExtractedPage[];
}

const MAX_PAGES = 5000;
const MAX_TEXT_CHARS = 10_000_000;
/** Below this across the whole file there is nothing useful to read: it's images, or at most a stray page number. */
const MIN_TEXT_CHARS = 20;

const MAX_ZIP_ENTRIES = 20_000;
/** What all entries claim to unpack to, including media that is never unpacked. */
const MAX_ZIP_DECLARED_BYTES = 1024 * 1024 * 1024;
/** What may actually be unpacked: only XML parts are read. */
const MAX_XML_PART_BYTES = 32 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 256 * 1024 * 1024;

const WRONG_TYPE = "Only PDF and PowerPoint (.pptx) files can be attached.";
const CORRUPT = "This file looks damaged and can't be read.";
const ENCRYPTED = "This file is password-protected. Remove the password and upload it again.";
const TOO_MUCH_TEXT = "This file has too much text to attach. Try uploading the part you need.";

/**
 * Keeps text that can be read and searched. Invisible formatting characters go too, since they can
 * hide text from the learner while the model still reads it. Ligatures and maths letters (𝑥) become
 * plain ones so a search finds them, while the rest of Unicode, such as ², is left alone.
 */
export function cleanText(text: string): string {
  return text
    .replace(/[^\P{C}\n\t]/gu, "")
    .replace(/[ﬀ-ﬆ\u{1D400}-\u{1D7FF}]/gu, (c: string) => c.normalize("NFKC"))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finish(kind: ExtractedDocument["kind"], pageCount: number, raw: ExtractedPage[]): ExtractedDocument {
  const pages = raw.map(({ page, text }) => ({ page, text: cleanText(text) })).filter((page) => page.text);
  if (pages.reduce((sum, page) => sum + page.text.replace(/\s/g, "").length, 0) < MIN_TEXT_CHARS) {
    throw new DocumentError(
      "no_text",
      kind === "pdf"
        ? "This PDF has no readable text; it's probably scanned. Mivra can't read images yet, so try a PDF with selectable text."
        : "These slides have no readable text; they're probably images. Mivra can't read images yet.",
    );
  }
  return { kind, pageCount, pages };
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  const { getDocument } = await getResolvedPDFJS();
  // This pdf.js build has no eval path for fonts (the CVE-2024-4367 route); text extraction never renders. It only warns on recoverable damage.
  // pdf.js refuses a Buffer, and takes ownership of what it's given.
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const pdf = await task.promise.catch((error: unknown) => {
      throw (error as Error)?.name === "PasswordException" ? new DocumentError("encrypted", ENCRYPTED) : new DocumentError("corrupt", CORRUPT);
    });
    if (pdf.numPages > MAX_PAGES) throw new DocumentError("too_complex", `This PDF has more than ${MAX_PAGES} pages.`);
    const pages: ExtractedPage[] = [];
    let chars = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      // One bad page shouldn't lose the rest; it counts as a page without text.
      const text = await pdf
        .getPage(page)
        .then(async (handle) => {
          const content = await handle.getTextContent();
          handle.cleanup();
          // Reading order is the file's own, which is usually right for columns but isn't guaranteed.
          return content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
        })
        .catch(() => "");
      chars += text.length;
      if (chars > MAX_TEXT_CHARS) throw new DocumentError("too_complex", TOO_MUCH_TEXT);
      pages.push({ page, text });
    }
    return finish("pdf", pdf.numPages, pages);
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** The zip's entries by name, with a reader for each that enforces the unpacked-size limits. */
function openZip(bytes: Uint8Array): Promise<{ names: Set<string>; read: (name: string) => Promise<Buffer>; close: () => void }> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Promise((resolve, reject) => {
    // yauzl rejects absolute paths, ".." and backslashes in names, and checks entries against their declared sizes.
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) return reject(new DocumentError("corrupt", CORRUPT));
      if (zip.entryCount > MAX_ZIP_ENTRIES) return reject(new DocumentError("too_complex", "This file contains too many parts to read safely."));
      const entries = new Map<string, yauzl.Entry>();
      let declared = 0;
      let unpacked = 0;
      zip.on("error", () => reject(new DocumentError("corrupt", CORRUPT)));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.isEncrypted()) return reject(new DocumentError("encrypted", ENCRYPTED));
        declared += entry.uncompressedSize;
        if (declared > MAX_ZIP_DECLARED_BYTES) return reject(new DocumentError("too_complex", "This file unpacks to too much data to read safely."));
        // Two entries with one name could show different content to different readers.
        if (entries.has(entry.fileName)) return reject(new DocumentError("corrupt", CORRUPT));
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      const read = (name: string) =>
        new Promise<Buffer>((done, fail) => {
          const entry = entries.get(name);
          if (!entry) return fail(new DocumentError("corrupt", CORRUPT));
          const tooMuch = new DocumentError("too_complex", "This file unpacks to too much data to read safely.");
          if (entry.uncompressedSize > MAX_XML_PART_BYTES) return fail(tooMuch);
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(new DocumentError("corrupt", CORRUPT));
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => {
              unpacked += chunk.length;
              if (unpacked > MAX_XML_TOTAL_BYTES) stream.destroy(tooMuch);
              else chunks.push(chunk);
            });
            stream.on("error", (error) => fail(error instanceof DocumentError ? error : new DocumentError("corrupt", CORRUPT)));
            stream.on("end", () => done(Buffer.concat(chunks)));
          });
        });
      zip.on("end", () => resolve({ names: new Set(entries.keys()), read, close: () => zip.close() }));
      zip.readEntry();
    });
  });
}

/** Office XML is UTF-8 or UTF-16. Any other declared encoding reads as damaged text, not as a risk. */
function decodeXml(bytes: Buffer): string {
  const [a, b] = bytes;
  const encoding = (a === 0xff && b === 0xfe) || (a === 0x3c && b === 0) ? "utf-16le" : (a === 0xfe && b === 0xff) || (a === 0 && b === 0x3c) ? "utf-16be" : "utf-8";
  const xml = new TextDecoder(encoding).decode(bytes);
  // Office never writes a DTD, so one means a crafted file. Nothing here expands entities anyway: see xmlTokens.
  if (/<!(DOCTYPE|ENTITY)/i.test(xml)) throw new DocumentError("corrupt", "This file contains unsafe XML and can't be read.");
  return xml;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The five predefined entities and character references. Any other entity stays as literal text. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex!, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Splits XML into tags and text without interpreting it, which is all these few element types need. */
function* xmlTokens(xml: string) {
  for (const [token] of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g)) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) yield { text: token.slice(9, -3) };
    else if (token.startsWith("<")) {
      const name = /^<\/?(?:[\w.-]+:)?([\w.-]+)/.exec(token)?.[1] ?? "";
      yield { tag: token, name, closing: token.startsWith("</"), selfClosing: token.endsWith("/>") };
    } else yield { text: decodeEntities(token) };
  }
}

/** Slide text: `a:t` runs and `m:t` equation runs, without `mc:Fallback`, which repeats content for old readers. */
function slideText(xml: string): string {
  let out = "";
  let inText = 0;
  let inFallback = 0;
  for (const token of xmlTokens(xml)) {
    if ("text" in token) {
      if (inText > 0 && inFallback === 0) out += token.text;
      continue;
    }
    const delta = token.selfClosing ? 0 : token.closing ? -1 : 1;
    if (token.name === "Fallback") inFallback = Math.max(0, inFallback + delta);
    else if (token.name === "t") inText = Math.max(0, inText + delta);
    else if (inFallback === 0 && (token.name === "br" || (token.name === "p" && token.closing))) out += "\n";
  }
  return out;
}

const attribute = (tag: string, name: RegExp) => new RegExp(`\\s${name.source}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1];

/** The presentation's slide parts in the order it shows them, which needn't match their file names. */
function slideOrder(presentationXml: string, relsXml: string): (string | undefined)[] {
  const targets = new Map<string, string>();
  for (const token of xmlTokens(relsXml)) {
    if ("tag" in token && token.name === "Relationship" && !token.closing) {
      const id = attribute(token.tag, /Id/);
      const target = attribute(token.tag, /Target/);
      if (id && target) targets.set(id, target);
    }
  }
  const slides: (string | undefined)[] = [];
  for (const token of xmlTokens(presentationXml)) {
    if ("tag" in token && token.name === "sldId" && !token.closing) {
      const target = targets.get(attribute(token.tag, /[\w.-]+:id/) ?? "");
      // Relationship targets come from the file, so only a part directly under ppt/slides is ever opened.
      const part = target && (target.startsWith("/") ? posix.normalize(target).slice(1) : posix.join("ppt", target));
      slides.push(part && /^ppt\/slides\/[^/]+\.xml$/.test(part) ? part : undefined);
    }
  }
  return slides;
}

async function extractPptx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const zip = await openZip(bytes);
  try {
    if (!zip.names.has("[Content_Types].xml")) throw new DocumentError("wrong_type", WRONG_TYPE);
    const types = decodeXml(await zip.read("[Content_Types].xml"));
    if (!/officedocument\.presentationml\.(presentation|slideshow|template)\.main\+xml/i.test(types)) throw new DocumentError("wrong_type", WRONG_TYPE);
    if (!zip.names.has("ppt/presentation.xml") || !zip.names.has("ppt/_rels/presentation.xml.rels")) throw new DocumentError("corrupt", CORRUPT);

    const slides = slideOrder(decodeXml(await zip.read("ppt/presentation.xml")), decodeXml(await zip.read("ppt/_rels/presentation.xml.rels")));
    if (slides.length > MAX_PAGES) throw new DocumentError("too_complex", `This file has more than ${MAX_PAGES} slides.`);
    const pages: ExtractedPage[] = [];
    let chars = 0;
    for (const [index, part] of slides.entries()) {
      if (!part || !zip.names.has(part)) continue;
      const text = slideText(decodeXml(await zip.read(part)));
      chars += text.length;
      if (chars > MAX_TEXT_CHARS) throw new DocumentError("too_complex", TOO_MUCH_TEXT);
      pages.push({ page: index + 1, text });
    }
    return finish("pptx", slides.length, pages);
  } finally {
    zip.close();
  }
}

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((byte, i) => bytes[i] === byte);

/** Dispatches on what the file contains, whatever it is called. */
export async function extractDocument(bytes: Uint8Array): Promise<ExtractedDocument> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The PDF spec lets a header sit a little way into the file.
  if (buffer.subarray(0, 1024).includes("%PDF-")) return extractPdf(bytes);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return extractPptx(bytes);
  // Office stores a password-protected .pptx in the same container as an old .ppt.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]) && buffer.includes(Buffer.from("EncryptedPackage", "utf16le"))) throw new DocumentError("encrypted", ENCRYPTED);
  throw new DocumentError("wrong_type", WRONG_TYPE);
}
