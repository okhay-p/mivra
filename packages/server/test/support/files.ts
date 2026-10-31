import { crc32, deflateRawSync } from "node:zlib";

/**
 * Small real files for extraction tests, built here so hostile variants are easy to forge. Used by the
 * browser tests too.
 */

const pdfEscape = (text: string) => text.replace(/[\\()]/g, "\\$&");

/** A PDF whose pages each hold lines of text in a standard font, or nothing, as a scan would. */
export function makePdf(pages: string[][], { extraObjects = [] as string[], contentStreams = undefined as Buffer[] | undefined, encrypt = false } = {}): Buffer {
  const objects: (string | Buffer)[] = [];
  const firstPage = 4;
  const kids = pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`);
    const stream = lines.map((line, n) => `BT /F1 12 Tf 50 ${740 - n * 16} Td (${pdfEscape(line)}) Tj ET`).join("\n");
    const custom = contentStreams?.[i];
    objects.push(custom ? Buffer.concat([Buffer.from(`<< /Length ${custom.length} /Filter /FlateDecode >>\nstream\n`), custom, Buffer.from("\nendstream")]) : `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push(...extraObjects);

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]);
    offsets.push(offset);
    offset += body.length;
    parts.push(body);
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  // A standard-security dictionary whose password nobody knows.
  const encryption = encrypt ? ` /Encrypt << /Filter /Standard /V 1 /R 2 /O (${"o".repeat(32)}) /U (${"u".repeat(32)}) /P -4 >> /ID [(a) (a)]` : "";
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** Forges the flag that says the entry is encrypted. */
  encrypted?: boolean;
  /** Forges the unpacked size the zip claims. */
  declaredSize?: number;
  stored?: boolean;
}

export function makeZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const packed = entry.stored ? data : deflateRawSync(data);
    const name = Buffer.from(entry.name);
    const flags = (entry.encrypted ? 1 : 0) | 0x800;
    const size = entry.declaredSize ?? data.length;
    const shared = Buffer.alloc(26);
    shared.writeUInt16LE(20, 0);
    shared.writeUInt16LE(flags, 2);
    shared.writeUInt16LE(entry.stored ? 0 : 8, 4);
    shared.writeUInt32LE(crc32(data), 10);
    shared.writeUInt32LE(packed.length, 14);
    shared.writeUInt32LE(size, 18);
    shared.writeUInt16LE(name.length, 22);
    const head = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, name]);
    local.push(head, packed);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), shared, tail, name);
    offset += head.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`;

export const slideXml = (lines: string[]) =>
  `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/** A .pptx; `order` lists the slide files in the order the deck shows them, default as given. */
export function pptxEntries(slides: string[], order: number[] = slides.map((_, i) => i)): ZipEntry[] {
  return [
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    {
      name: "ppt/presentation.xml",
      data: `<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="r">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
    },
    ...slides.map((xml, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: xml })),
  ];
}

export const makePptx = (slides: string[][], order?: number[]) => makeZip(pptxEntries(slides.map(slideXml), order));
