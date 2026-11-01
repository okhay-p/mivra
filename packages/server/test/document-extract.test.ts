import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { chunkPages } from "../src/documents/chunk.js";
import { extractInWorker } from "../src/documents/extract-in-worker.js";
import { DocumentError, cleanText, extractDocument, type DocumentErrorCode } from "../src/documents/extract.js";
import { sanitizeFilename } from "../src/documents/upload.js";
import { makePdf, makePptx, makeZip, pptxEntries, slideXml } from "./support/files.js";

// Starting a worker through tsx takes seconds on a busy machine, and some of these files are large.
vi.setConfig({ testTimeout: 60_000 });

const WORDS = "Relations and functions are the foundation of discrete mathematics.";
/** Parsers run in-process here, since starting a worker for each case takes seconds. The worker has its own tests below. */
const fails = async (bytes: Uint8Array, code: DocumentErrorCode, extract: (bytes: Uint8Array) => Promise<unknown> = extractDocument) => {
  const error = await extract(bytes).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DocumentError);
  expect((error as DocumentError).code).toBe(code);
  return (error as DocumentError).message;
};

describe("PDF extraction", () => {
  it("reads text page by page", async () => {
    const result = await extractDocument(makePdf([[WORDS, "Second line"], ["Page two text here, long enough."]]));
    expect(result).toMatchObject({ kind: "pdf", pageCount: 2 });
    expect(result.pages[0]).toMatchObject({ page: 1 });
    expect(result.pages[0]!.text).toContain("Relations and functions");
    expect(result.pages[0]!.text).toContain("Second line");
    expect(result.pages[1]).toMatchObject({ page: 2 });
  });

  it("keeps the page number of later pages when one has no text", async () => {
    const result = await extractDocument(makePdf([[WORDS], [], ["The third page has words."]]));
    expect(result.pageCount).toBe(3);
    expect(result.pages.map((p) => p.page)).toEqual([1, 3]);
  });

  it("explains a scanned PDF instead of storing an empty document", async () => {
    expect(await fails(makePdf([[], []]), "no_text")).toMatch(/scanned/);
    await fails(makePdf([["12"]]), "no_text");
  });

  it("refuses a password-protected PDF cleanly", async () => {
    expect(await fails(makePdf([[WORDS]], { encrypt: true }), "encrypted")).toMatch(/password/);
  });

  it("refuses a corrupt PDF cleanly", async () => {
    await fails(Buffer.from("%PDF-1.7\nthis is not really a pdf at all"), "corrupt");
    await fails(makePdf([[WORDS]]).subarray(0, 40), "corrupt");
  });
});

describe("PPTX extraction", () => {
  it("reads slides in the deck's order, not file order", async () => {
    const result = await extractDocument(makePptx([["File one has its own words"], ["File two has its own words"]], [1, 0]));
    expect(result).toMatchObject({ kind: "pptx", pageCount: 2 });
    expect(result.pages.map((p) => [p.page, p.text])).toEqual([
      [1, "File two has its own words"],
      [2, "File one has its own words"],
    ]);
  });

  it("decodes standard entities and reads equations once, without their fallback", async () => {
    const xml =
      `<p:sld xmlns:a="a" xmlns:m="m" xmlns:mc="mc"><a:p><a:r><a:t>A &amp; B &lt;= C, &#8712; set of things</a:t></a:r></a:p>` +
      `<mc:AlternateContent><mc:Choice><a14:m><m:oMath><m:r><m:t>x∈A∪B</m:t></m:r></m:oMath></a14:m></mc:Choice><mc:Fallback><a:p><a:r><a:t>EQUATION FALLBACK</a:t></a:r></a:p></mc:Fallback></mc:AlternateContent></p:sld>`;
    const { pages } = await extractDocument(makeZip(pptxEntries([xml])));
    expect(pages[0]!.text).toContain("A & B <= C, ∈ set of things");
    expect(pages[0]!.text).toContain("x∈A∪B");
    expect(pages[0]!.text).not.toContain("FALLBACK");
  });

  it("explains a deck of pictures", async () => {
    await fails(makePptx([[], []]), "no_text");
  });

  it("refuses other zips, whatever they are called", async () => {
    await fails(makeZip([{ name: "word/document.xml", data: "<w/>" }]), "wrong_type");
    await fails(makeZip([{ name: "[Content_Types].xml", data: "<Types>wordprocessingml.document.main+xml</Types>" }]), "wrong_type");
  });

  it("refuses an entity-expansion attack without expanding it", async () => {
    const lol = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><p:sld><a:t>&lol2;</a:t></p:sld>`;
    expect(await fails(makeZip(pptxEntries([lol])), "corrupt")).toMatch(/unsafe XML/);
    // UTF-16 doesn't hide it.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lol, "utf16le")]);
    await fails(makeZip(pptxEntries([utf16.toString("latin1")]).map((e) => (e.name.includes("slide1") ? { ...e, data: utf16 } : e))), "corrupt");
  });

  it("leaves an undeclared entity as literal text", async () => {
    const { pages } = await extractDocument(makeZip(pptxEntries([slideXml(["The file says &xxe; in its own words here"])])));
    expect(pages[0]!.text).toContain("&xxe;");
  });

  it("refuses a zip bomb that admits its size", async () => {
    const entries = pptxEntries([slideXml([WORDS])]);
    const zip = makeZip(entries.map((e) => (e.name.includes("slide1") ? { ...e, data: Buffer.alloc(64 * 1024 * 1024, 0x20) } : e)));
    expect(zip.length).toBeLessThan(200 * 1024);
    expect(await fails(zip, "too_complex")).toMatch(/too much data/);
  });

  it("refuses a zip bomb that lies about its size", async () => {
    const entries = pptxEntries([slideXml([WORDS])]);
    const zip = makeZip(entries.map((e) => (e.name.includes("slide1") ? { ...e, data: Buffer.alloc(16 * 1024 * 1024, 0x20), declaredSize: 100 } : e)));
    await fails(zip, "corrupt");
  });

  it("refuses a zip claiming an enormous unpacked size, even in a part it wouldn't read", async () => {
    const zip = makeZip([...pptxEntries([slideXml([WORDS])]), ...Array.from({ length: 3 }, (_, i) => ({ name: `ppt/media/${i}.bin`, data: "x", declaredSize: 0xfffffff0 }))]);
    await fails(zip, "too_complex");
  });

  it("refuses a zip with too many entries", async () => {
    const zip = makeZip([...pptxEntries([slideXml([WORDS])]), ...Array.from({ length: 20_001 }, (_, i) => ({ name: `f${i}`, data: "", stored: true }))]);
    expect(await fails(zip, "too_complex")).toMatch(/too many parts/);
  });

  it.each(["../../etc/passwd", "/etc/passwd", "ppt\\slides\\slide1.xml"])("refuses the path trick %s", async (name) => {
    await fails(makeZip([{ name, data: "x" }, ...pptxEntries([slideXml([WORDS])])]), "corrupt");
  });

  it("never opens a slide part outside ppt/slides, wherever a relationship points", async () => {
    const entries = pptxEntries([slideXml(["Inside the slides folder, a normal slide"])]);
    const rels = `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="../secret.xml"/></Relationships>`;
    const zip = makeZip([
      ...entries.map((e) => (e.name.endsWith(".rels") ? { ...e, data: rels } : e.name.endsWith("presentation.xml") ? { ...e, data: `<p:presentation><p:sldId r:id="rId1"/><p:sldId r:id="rId2"/></p:presentation>` } : e)),
      { name: "secret.xml", data: slideXml(["SECRET PART"]) },
    ]);
    const result = await extractDocument(zip);
    expect(result.pageCount).toBe(2);
    expect(JSON.stringify(result.pages)).not.toContain("SECRET");
  });

  it("refuses duplicate entries", async () => {
    const entries = pptxEntries([slideXml([WORDS])]);
    await fails(makeZip([...entries, entries.at(-1)!]), "corrupt");
  });

  it("refuses encrypted entries and Office's encrypted container cleanly", async () => {
    await fails(makeZip(pptxEntries([slideXml([WORDS])]).map((e) => ({ ...e, encrypted: true }))), "encrypted");
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("EncryptedPackage", "utf16le")]);
    expect(await fails(ole, "encrypted")).toMatch(/password/);
  });

  it("refuses a corrupt zip cleanly", async () => {
    const zip = makePptx([[WORDS]]);
    await fails(zip.subarray(0, zip.length - 30), "corrupt");
    const damaged = Buffer.from(zip);
    damaged.fill(0xff, 60, 200);
    await expect(extractInWorker(damaged)).rejects.toBeInstanceOf(DocumentError);
  });
});

describe("file types", () => {
  it("decides by content, not name", async () => {
    await fails(Buffer.from("just some text pretending to be a pdf"), "wrong_type");
    await fails(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), "wrong_type");
    // An old .ppt shares the container but has no encrypted package.
    await fails(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "wrong_type");
  });
});

describe("the worker", () => {
  it("extracts off the main thread, which keeps running meanwhile", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    const result = await extractInWorker(makePdf(Array.from({ length: 50 }, (_, i) => [`${WORDS} ${i}`])));
    clearInterval(ticker);
    expect(result.pageCount).toBe(50);
    expect(ticks).toBeGreaterThan(10);
  });

  it("carries a parser's error across the thread", async () => {
    await fails(Buffer.from("not a document"), "wrong_type", (bytes) => extractInWorker(bytes));
  });

  it("stops at the timeout", async () => {
    await fails(makePdf([[WORDS]]), "timeout", (bytes) => extractInWorker(bytes, { timeoutMs: 20 }));
  });

  it("reports running out of heap as a clean error, and the server lives on", async () => {
    const file = makePdf(Array.from({ length: 4000 }, (_, i) => [`${WORDS} ${i}`]));
    await fails(file, "too_complex", (bytes) => extractInWorker(bytes, { maxHeapMb: 16 }));
  });

  it("stops a PDF whose stream decompresses into a bomb", async () => {
    // Half a gigabyte of zeros in a small file, against a much lower limit.
    const bomb = deflateSync(Buffer.alloc(512 * 1024 * 1024));
    const file = makePdf([[WORDS]], { contentStreams: [bomb] });
    expect(file.length).toBeLessThan(1024 * 1024);
    await fails(file, "too_complex", (bytes) => extractInWorker(bytes, { maxRssGrowthBytes: 64 * 1024 * 1024 }));
  }, 40_000);

  it("stops when the client goes away", async () => {
    const controller = new AbortController();
    const running = extractInWorker(makePdf(Array.from({ length: 200 }, () => [WORDS])), { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(DocumentError);
  });
});

describe("text handling", () => {
  it("removes control and invisible characters, and normalises ligatures and maths letters", () => {
    expect(cleanText("a\u0000b\u202Ec\u200Bd\u{E0041}e")).toBe("abcde");
    expect(cleanText("ﬁnite 𝑥 x² ∈ A")).toBe("finite x x² ∈ A");
    expect(cleanText("a   b\n\n\n\nc")).toBe("a b\n\nc");
  });

  it("chunks long pages without losing words or their page", () => {
    const line = "word ".repeat(100).trim();
    const chunks = chunkPages([{ page: 7, text: Array.from({ length: 10 }, () => line).join("\n") }, { page: 9, text: "x".repeat(3000) }]);
    expect(chunks.every((c) => c.text.length <= 1200)).toBe(true);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(chunks.filter((c) => c.page === 7).reduce((n, c) => n + c.text.match(/word/g)!.length, 0)).toBe(1000);
    expect(chunks.filter((c) => c.page === 9).map((c) => c.text).join("")).toHaveLength(3000);
  });

  it("sanitises filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\notes.pdf")).toBe("notes.pdf");
    expect(sanitizeFilename("evil\u202Efdp.exe\u0000\n.pdf")).toBe("evilfdp.exe.pdf");
    expect(sanitizeFilename("")).toBe("document");
    expect(sanitizeFilename("..")).toBe("document");
    const long = sanitizeFilename(`${"a".repeat(500)}.pdf`);
    expect([...long].length).toBe(120);
    expect(long.endsWith("….pdf")).toBe(true);
  });
});
