/**
 * Browser-only pdf.js loader. Kept apart from extract.ts so Node (vitest,
 * scripts) never evaluates the Vite `?url` import; Node callers inject the
 * legacy build instead.
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfjsModule } from './extract';

let loading: Promise<PdfjsModule> | null = null;

/** Lazy-load pdf.js once and point it at the worker bundled by Vite. */
export function loadBrowserPdfjs(): Promise<PdfjsModule> {
  loading ??= import('pdfjs-dist')
    .then((pdfjs): PdfjsModule => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })
    .catch((err: unknown) => {
      // Allow a retry (e.g. after a chunk failed to load) instead of caching the failure.
      loading = null;
      throw err;
    });
  return loading;
}
