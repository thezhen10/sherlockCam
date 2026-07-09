// Runs zxing-wasm's decoding off the main thread. Kept deliberately tiny and
// dependency-free beyond zxing-wasm itself, so it stays cheap to parse/start.
//
// Note: we deliberately avoid `/// <reference lib="webworker" />` here and
// use a minimal duck-typed scope instead - mixing the full "webworker" lib
// with the project's "dom" lib (used everywhere else) causes conflicting
// global declarations (e.g. `self`) during type-checking/declaration output.
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';

export interface ZxingWorkerRequest {
  id: number;
  imageData: ImageData;
  options?: ReaderOptions;
}

export interface ZxingWorkerResult {
  text: string;
  format: string;
}

export interface ZxingWorkerResponse {
  id: number;
  results?: ZxingWorkerResult[];
  error?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ZxingWorkerRequest>) => void) | null;
  postMessage(message: ZxingWorkerResponse): void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (event: MessageEvent<ZxingWorkerRequest>) => {
  const { id, imageData, options } = event.data;

  try {
    const results = await readBarcodes(imageData, options);
    const response: ZxingWorkerResponse = {
      id,
      results: results.map((result) => ({ text: result.text, format: result.format })),
    };
    ctx.postMessage(response);
  } catch (error) {
    const response: ZxingWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(response);
  }
};
