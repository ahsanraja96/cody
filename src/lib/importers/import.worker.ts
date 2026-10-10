/// <reference lib="webworker" />
import { parseImport, type ImportResult, type ImportSource } from './index';

/** Parsing runs here so a 50 MB export never freezes the page. */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<{ source: ImportSource; text: string }>) => {
  let result: ImportResult;
  try {
    result = parseImport(event.data.source, event.data.text);
  } catch (error) {
    console.error('[tabfold] import parse failed', error);
    result = { sessions: [], tabCount: 0, skipped: 1 };
  }
  self.postMessage(result);
};
