import { z } from "zod";

/** The largest file the learner can upload (ADR-010). The server enforces it while reading. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** What a client sees of an uploaded document. Its text stays on the server. */
export const DocumentView = z.object({
  id: z.string(),
  sessionId: z.string(),
  filename: z.string(),
  kind: z.enum(["pdf", "pptx"]),
  byteSize: z.number().int(),
  pageCount: z.number().int(),
  pagesWithText: z.number().int(),
  status: z.literal("ready"),
  createdAt: z.string().datetime(),
});
export type DocumentView = z.infer<typeof DocumentView>;
