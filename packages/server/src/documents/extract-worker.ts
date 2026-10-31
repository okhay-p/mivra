import { parentPort, workerData } from "node:worker_threads";
import { DocumentError, extractDocument } from "./extract.js";

/** Runs one extraction and reports it. The parent kills this thread if it takes too long. */
try {
  const document = await extractDocument((workerData as { bytes: Uint8Array }).bytes);
  parentPort!.postMessage({ ok: true, document });
} catch (error) {
  parentPort!.postMessage(
    error instanceof DocumentError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "corrupt", message: "This file looks damaged and can't be read." },
  );
}
