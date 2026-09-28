/**
 * Positioned text extraction from PDF files with pdf.js.
 *
 * Payroll and wage determination PDFs arrive by email from third parties, so
 * the loader is configured defensively: no eval, no font-face injection, no
 * XFA, and a cap on the number of pages read. Coordinates are normalized to
 * PDF points with the origin at the bottom-left of the page as displayed, so
 * pages carrying a /Rotate entry read the same as unrotated ones. Values typed
 * into fillable form fields that were never flattened are read too, since they
 * are not part of the page's own text.
 */

export interface PdfTextItem {
  str: string;
  /** Left edge of the text run, in points from the left of the page. */
  x: number;
  /** Baseline, in points from the bottom of the page. */
  y: number;
  /** Advance width of the run along its direction, in points. */
  w: number;
  h: number;
  fontSize: number;
  /** Text direction in degrees counter-clockwise (0 = normal horizontal text). */
  angle: number;
  /** pdf.js font id; runs set in the same font share it. */
  fontName: string;
  /** The font is fixed-pitch (Courier and the like). */
  monospace: boolean;
  /** The value of a fillable form field rather than page text. */
  formField?: boolean;
}

export interface PdfTextPage {
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface PdfText {
  pages: PdfTextPage[];
  /** False when no page carries any visible characters (scanned or image-only PDF). */
  hasText: boolean;
}

export type PdfReadErrorCode = 'empty' | 'not-pdf' | 'encrypted' | 'corrupt' | 'too-many-pages';

/** A PDF that cannot be read; `code` lets the UI explain what the user can do about it. */
export class PdfReadError extends Error {
  readonly code: PdfReadErrorCode;

  constructor(code: PdfReadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfReadError';
    this.code = code;
  }
}

// Structural subset of the pdf.js API that this module uses. Both the modern
// build (browser) and the legacy build (Node) satisfy it.

export interface PdfjsDocumentParams {
  data: Uint8Array;
  isEvalSupported: boolean;
  disableFontFace: boolean;
  enableXfa: boolean;
  useSystemFonts: boolean;
  stopAtErrors: boolean;
  verbosity: number;
}

export interface PdfjsViewportLike {
  width: number;
  height: number;
  transform: number[];
}

export interface PdfjsPageLike {
  getViewport(params: { scale: number }): PdfjsViewportLike;
  getTextContent(): Promise<{ items: readonly unknown[]; styles?: Record<string, { fontFamily?: string }> }>;
  getAnnotations?(params?: { intent?: string }): Promise<unknown[]>;
  cleanup(): unknown;
}

export interface PdfjsDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPageLike>;
}

export interface PdfjsLoadingTaskLike {
  promise: Promise<PdfjsDocumentLike>;
  destroy(): Promise<void>;
}

export interface PdfjsModule {
  getDocument(params: PdfjsDocumentParams): PdfjsLoadingTaskLike;
}

export interface ExtractOptions {
  /** pdf.js module to use. Node callers pass 'pdfjs-dist/legacy/build/pdf.mjs'; the browser lazy-loads its own. */
  pdfjs?: PdfjsModule;
  /** Refuse documents with more pages than this (default 400). */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 400;

/**
 * Read every text run of a PDF with its position. Throws PdfReadError for
 * empty, non-PDF, password-protected or unreadable files.
 */
export async function extractPdfText(data: Uint8Array, opts: ExtractOptions = {}): Promise<PdfText> {
  if (!data || data.byteLength === 0) throw new PdfReadError('empty', 'The file is empty.');
  if (!hasPdfHeader(data)) {
    throw new PdfReadError('not-pdf', 'This file is not a PDF (it does not start with a PDF header).');
  }
  const pdfjs = opts.pdfjs ?? (await loadDefaultPdfjs());
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const task = pdfjs.getDocument({
    // pdf.js may transfer the buffer to its worker; keep the caller's copy intact.
    data: data.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  try {
    let doc: PdfjsDocumentLike;
    try {
      doc = await task.promise;
    } catch (err) {
      throw toReadError(err);
    }
    if (doc.numPages > maxPages) {
      throw new PdfReadError(
        'too-many-pages',
        `This PDF has ${doc.numPages} pages; Wagebench reads at most ${maxPages}. Split the file and import the relevant pages.`,
      );
    }
    const pages: PdfTextPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      try {
        const page = await doc.getPage(n);
        pages.push(await readPage(page));
        page.cleanup();
      } catch (err) {
        throw toReadError(err, n);
      }
    }
    const hasText = pages.some((p) => p.items.some((i) => i.str.trim() !== ''));
    return { pages, hasText };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function loadDefaultPdfjs(): Promise<PdfjsModule> {
  const browser = await import('./pdfjs-browser');
  return browser.loadBrowserPdfjs();
}

function hasPdfHeader(data: Uint8Array): boolean {
  // The spec allows junk before the header; readers accept it within the first kilobyte.
  const limit = Math.min(data.byteLength - 4, 1024);
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0x25 && data[i + 1] === 0x50 && data[i + 2] === 0x44 && data[i + 3] === 0x46 && data[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

function toReadError(err: unknown, pageNumber?: number): PdfReadError {
  if (err instanceof PdfReadError) return err;
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'PasswordException') {
    return new PdfReadError(
      'encrypted',
      'This PDF is password protected. Ask the contractor for an unprotected copy, or open it, print it to a new PDF and import that.',
      { cause: err },
    );
  }
  const where = pageNumber ? ` (page ${pageNumber})` : '';
  const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
  return new PdfReadError('corrupt', `The PDF could not be read${where}${detail}. It may be damaged or incomplete.`, {
    cause: err,
  });
}

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

function isRawTextItem(item: unknown): item is RawTextItem {
  if (!item || typeof item !== 'object') return false;
  const o = item as Record<string, unknown>;
  return typeof o.str === 'string' && Array.isArray(o.transform) && o.transform.length >= 6;
}

async function readPage(page: PdfjsPageLike): Promise<PdfTextPage> {
  const viewport = page.getViewport({ scale: 1 });
  const [va = 1, vb = 0, vc = 0, vd = -1, ve = 0, vf = viewport.height] = viewport.transform;
  const content = await page.getTextContent();
  const styles = content.styles ?? {};
  const items: PdfTextItem[] = [];
  for (const raw of content.items) {
    if (!isRawTextItem(raw) || raw.str === '') continue;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = raw.transform.map(Number);
    // Viewport space has y pointing down; flip back so y grows upward like PDF space.
    const vx = va * e + vc * f + ve;
    const vy = vb * e + vd * f + vf;
    const dx = va * a + vc * b;
    const dy = vb * a + vd * b;
    const fontSize = Math.hypot(c, d) || Math.abs(raw.height) || 0;
    const fontName = typeof raw.fontName === 'string' ? raw.fontName : '';
    items.push({
      str: raw.str,
      x: round2(vx),
      y: round2(viewport.height - vy),
      w: round2(Math.abs(raw.width) || 0),
      h: round2(Math.abs(raw.height) || fontSize),
      fontSize: round2(fontSize),
      angle: Math.round((Math.atan2(-dy, dx) * 180) / Math.PI) || 0,
      fontName,
      monospace: styles[fontName]?.fontFamily === 'monospace',
    });
  }
  if (page.getAnnotations) {
    const toViewport = (x: number, y: number): [number, number] => [va * x + vc * y + ve, vb * x + vd * y + vf];
    items.push(...fieldItems(await page.getAnnotations({ intent: 'display' }), toViewport, viewport.height));
  }
  return { width: round2(viewport.width), height: round2(viewport.height), items };
}

interface RawWidget {
  subtype?: unknown;
  fieldType?: unknown;
  fieldValue?: unknown;
  rect?: unknown;
  hidden?: unknown;
  checkBox?: unknown;
  radioButton?: unknown;
  buttonValue?: unknown;
  defaultAppearanceData?: { fontSize?: unknown } | null;
}

const AVERAGE_CHAR_EM = 0.5;

/**
 * Turn filled-in form field values into text items placed where the field
 * sits: text and choice values as typed, ticked checkboxes and radio buttons
 * as "X", so the page reads the same as if the form had been flattened.
 */
function fieldItems(
  annotations: readonly unknown[],
  toViewport: (x: number, y: number) => [number, number],
  pageHeight: number,
): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const a of annotations as RawWidget[]) {
    if (!a || a.subtype !== 'Widget' || a.hidden === true || !Array.isArray(a.rect) || a.rect.length < 4) continue;
    const [x1, y1, x2, y2] = (a.rect as unknown[]).map(Number) as [number, number, number, number];
    const [ax, ay] = toViewport(x1, y1);
    const [bx, by] = toViewport(x2, y2);
    const left = Math.min(ax, bx);
    const width = Math.abs(bx - ax);
    const bottom = pageHeight - Math.max(ay, by);
    const height = Math.abs(by - ay);
    if (!(width > 0 && height > 0)) continue;

    let lines: string[] = [];
    if (a.fieldType === 'Tx' && typeof a.fieldValue === 'string') lines = a.fieldValue.split(/\r\n?|\n/);
    else if (a.fieldType === 'Ch') lines = [([] as unknown[]).concat(a.fieldValue ?? []).map(String).join(', ')];
    else if (a.fieldType === 'Btn') {
      const on =
        a.checkBox === true
          ? typeof a.fieldValue === 'string' && a.fieldValue !== '' && a.fieldValue !== 'Off'
          : a.radioButton === true && a.fieldValue !== undefined && a.fieldValue === a.buttonValue;
      if (on) lines = ['X'];
    }
    lines = lines.map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const declared = Number(a.defaultAppearanceData?.fontSize);
    const fontSize = declared > 0 ? declared : Math.min(10, (height / lines.length) * 0.7);
    const centered = lines.length === 1 && lines[0] === 'X';
    lines.forEach((str, i) => {
      const w = Math.min(width, str.length * AVERAGE_CHAR_EM * fontSize);
      // Place each line so its middle falls in the field's band, top line first.
      const bandTop = bottom + height - (i * height) / lines.length;
      const bandMid = bandTop - height / lines.length / 2;
      out.push({
        str,
        x: round2(centered ? left + (width - w) / 2 : left + Math.min(2, width / 10)),
        y: round2(bandMid - 0.35 * fontSize),
        w: round2(w),
        h: round2(fontSize),
        fontSize: round2(fontSize),
        angle: 0,
        fontName: '',
        monospace: false,
        formField: true,
      });
    });
  }
  return out;
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
