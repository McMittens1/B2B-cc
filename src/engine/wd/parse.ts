import type {
  ParsedWageDetermination,
  RateIdKind,
  WDClassification,
  WDModification,
  WDRateBlock,
} from '../types';
import { parseFringe } from './fringe';

/**
 * Parse the text of a Davis-Bacon general wage determination as published on
 * SAM.gov (the same layout DOL has used since the WDOL era).
 *
 * The body is a sequence of rate blocks. Each block starts with a rate
 * identifier and effective date, optionally names an area, then lists
 * classifications with dotted leaders:
 *
 *    ELEC0001-005 06/01/2025
 *                                      Rates          Fringes
 *    ELECTRICIAN......................$ 44.00          3%+21.00
 *
 * Classification names can wrap over several lines, can be nested under a
 * heading ("LABORER" / "     GROUP 1....$ 35.20"), and blocks can carry notes
 * such as group definitions or "rates are per day". Nesting is resolved from
 * relative indentation, so callers should preserve leading spaces.
 */
export function parseWageDetermination(input: string): ParsedWageDetermination {
  const text = normalizeText(input);
  const lines = text.split('\n');
  const warnings: string[] = [];

  const header = parseHeader(text);
  const modifications = parseModifications(lines);

  // Locate the body: from the first rate identifier to the first footer marker after it.
  let bodyStart = lines.findIndex((l) => RATE_ID_LINE.test(l));
  let bodyEnd = lines.length;
  if (bodyStart >= 0) {
    for (let i = bodyStart + 1; i < lines.length; i++) {
      if (isFooterMarker(lines[i]!)) {
        bodyEnd = i;
        break;
      }
    }
  }

  const classifications: WDClassification[] = [];
  const blocks: WDRateBlock[] = [];
  const idOccurrences = new Map<string, number>();

  if (bodyStart < 0) {
    warnings.push(
      'No rate identifiers (for example "ELEC0001-005 06/01/2025") were found. Paste the full wage determination text from SAM.gov.',
    );
    bodyStart = lines.length;
  }

  // Split the body into blocks at each rate identifier line.
  const starts: number[] = [];
  for (let i = bodyStart; i < bodyEnd; i++) if (RATE_ID_LINE.test(lines[i]!)) starts.push(i);
  for (let b = 0; b < starts.length; b++) {
    const start = starts[b]!;
    const end = b + 1 < starts.length ? starts[b + 1]! : bodyEnd;
    const result = parseBlock(lines, start, end, idOccurrences);
    blocks.push(result.block);
    classifications.push(...result.classifications);
    warnings.push(...result.warnings);
  }

  const generalNotes = [
    bodyStart > 0 ? extractPreambleNotes(lines.slice(0, Math.min(bodyStart, lines.length))) : '',
    lines.slice(bodyEnd).join('\n').trim(),
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!header.decisionNumber) warnings.push('General Decision Number not found in the text.');
  if (classifications.length === 0 && starts.length > 0)
    warnings.push('Rate identifiers were found but no classification rate lines could be read.');

  const currentModification = modifications.length
    ? Math.max(...modifications.map((m) => m.number))
    : null;

  return {
    ...header,
    modifications,
    currentModification,
    classifications,
    blocks,
    generalNotes,
    warnings,
  };
}

// ---------------------------------------------------------------------------

const RATE_ID_LINE =
  /^\s*\*?\s*([A-Z][A-Z0-9]{1,7}(?:-[A-Z0-9]{1,6}){1,2})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/;

/** A classification rate line: label, dotted leader, "$ rate", optional "**", fringe. */
const RATE_LINE = /^(\s*)(.*?)\s*\.+\s*\$\s*([\d,]*\.?\d+)\s*(\*{1,2})?\s*(.*?)\s*$/;
/** Same, for text that lost its dotted leaders (label, 2+ spaces, $ rate). */
const RATE_LINE_NO_DOTS = /^(\s*)(\S.*?)\s{2,}\$\s*([\d,]*\.?\d+)\s*(\*{1,2})?\s*(.*?)\s*$/;
/** Fringe column text: empty, or numbers / percents / footnote letters joined by "+". */
const FRINGE_TEXT = /^(?:(?:\d*\.?\d+%?|[A-Za-z]{1,3})(?:\s*[+&,]\s*(?:\d*\.?\d+%?|[A-Za-z]{1,3}))*)?$/;

function matchRateLine(raw: string): RegExpExecArray | null {
  if (!raw.includes('$')) return null;
  const m = RATE_LINE.exec(raw) ?? RATE_LINE_NO_DOTS.exec(raw);
  if (!m) return null;
  const fringe = (m[5] ?? '').replace(/\*+/g, '').trim();
  if (!FRINGE_TEXT.test(fringe)) return null;
  return m;
}

const PER_DAY_NOTE =
  /amounts?\s+in\s+\W{0,2}rates?\W{0,2}\s+column\s+(?:are|is)\s+per\s+day|\brates?\s+(?:shown\s+|listed\s+|above\s+)?(?:are|is)\s+(?:per\s+day|daily)\b/i;
const HEADER_LINE = /^\s*Rates\s+Fringes\s*$/i;
const SEPARATOR_LINE = /^\s*-{5,}\s*$/;

const FOOTER_MARKERS = [
  /^={5,}/,
  /^WELDERS\s*[-–—]/i,
  /^Unlisted classifications needed/i,
  /^\*{1,2}\s*Workers in this classification/i,
  /^Note:\s*Executive Order/i,
  /^The body of each wage determination/i,
  /^WAGE DETERMINATION APPEALS PROCESS/i,
  /^END OF GENERAL DECISION/i,
  /^Union Rate Identifiers/i,
];

function isFooterMarker(line: string): boolean {
  const t = line.trim();
  return FOOTER_MARKERS.some((re) => re.test(t));
}

export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[   ]/g, ' ')
    .replace(/…/g, '...')
    .replace(/[‐-―]/g, '-');
}

function isoDate(mdY: string | undefined | null): string | null {
  if (!mdY) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(mdY.trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const month = String(Number(m[1])).padStart(2, '0');
  const day = String(Number(m[2])).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function rateIdKind(id: string): RateIdKind {
  if (/^SU[A-Z]{2}\d{4}-/.test(id)) return 'survey';
  if (/^UAVG-/.test(id)) return 'union-average';
  if (/^SA[A-Z]{2}\d{4}-/.test(id)) return 'state-adopted';
  if (/^[A-Z]{4}\d{4}-\d{3}$/.test(id)) return 'union';
  return 'other';
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Multi-line "Label: value" fields end at the first blank line. */
function multilineField(text: string, label: RegExp): string | null {
  const m = label.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const stop = rest.search(/\n\s*\n/);
  return collapse(stop >= 0 ? rest.slice(0, stop) : rest.split('\n')[0]!) || null;
}

function parseHeader(text: string) {
  const gd = /General Decision Number:\s*([A-Z]{2}\d{6,8})(?:\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))?/i.exec(text);
  const sup = /Superseded General Decision Numbers?:\s*([A-Z]{2}\d{6,8})/i.exec(text);
  const state = /^\s*State:\s*(.+)$/im.exec(text);
  return {
    decisionNumber: gd ? gd[1]!.toUpperCase() : null,
    decisionDate: gd ? isoDate(gd[2]) : null,
    supersededDecision: sup ? sup[1]!.toUpperCase() : null,
    state: state ? collapse(state[1]!) : null,
    constructionTypes: multilineField(text, /^\s*Construction Types?:\s*/im),
    counties: multilineField(text, /^\s*Count(?:y|ies):\s*/im),
  };
}

function parseModifications(lines: string[]): WDModification[] {
  const mods: WDModification[] = [];
  const idx = lines.findIndex((l) => /Modification\s+Number\s+Publication\s+Date/i.test(l));
  if (idx < 0) return mods;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '' && mods.length === 0) continue;
    const m = /^\s*(\d{1,3})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/.exec(l);
    if (!m) break;
    mods.push({ number: Number(m[1]), publicationDate: isoDate(m[2]) });
  }
  return mods;
}

function extractPreambleNotes(pre: string[]): string {
  // Keep "Note:" paragraphs from the preamble (e.g. Executive Order minimum wage notes).
  const text = pre.join('\n');
  const idx = text.search(/^\s*Note:/im);
  if (idx < 0) return '';
  const modIdx = text.search(/Modification\s+Number\s+Publication\s+Date/i);
  return text.slice(idx, modIdx > idx ? modIdx : undefined).trim();
}

interface PendingLine {
  indent: number;
  text: string;
  /** A blank line appeared between this line and the previous non-blank line. */
  blankBefore: boolean;
  line: number;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function parseBlock(
  lines: string[],
  start: number,
  end: number,
  idOccurrences: Map<string, number>,
): { block: WDRateBlock; classifications: WDClassification[]; warnings: string[] } {
  const idMatch = RATE_ID_LINE.exec(lines[start]!)!;
  const rateId = idMatch[1]!;
  const effective = isoDate(idMatch[2]);
  const kind = rateIdKind(rateId);
  const warnings: string[] = [];
  const out: WDClassification[] = [];
  const notes: string[] = [];

  let scope: string | null = null;
  let parent: { indent: number; text: string } | null = null;
  let pending: PendingLine[] = [];
  let sawBlank = false;

  const flushPendingToNotes = () => {
    for (const p of pending) notes.push(p.text);
    pending = [];
  };

  for (let i = start + 1; i < end; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') {
      sawBlank = true;
      continue;
    }
    if (SEPARATOR_LINE.test(raw)) {
      flushPendingToNotes();
      parent = null;
      sawBlank = true;
      continue;
    }
    if (HEADER_LINE.test(raw)) {
      // Lines just before a "Rates Fringes" header name the area the rates apply to.
      const groups = splitIntoGroups(pending);
      const last = groups.pop() ?? [];
      for (const g of groups) for (const p of g) notes.push(p.text);
      if (last.length > 0 && last.length <= 4) scope = collapse(last.map((p) => p.text).join(' '));
      else for (const p of last) notes.push(p.text);
      pending = [];
      parent = null;
      sawBlank = false;
      continue;
    }

    const m = matchRateLine(raw);
    if (m) {
      const rateIndent = m[1]!.length;
      const groups = splitIntoGroups(pending);
      // The group touching the rate line (no blank in between) is label text.
      const adjacent = sawBlank ? [] : groups.pop() ?? [];
      // Earlier groups: a single short heading line indented less than the rate line is a parent;
      // anything else is descriptive text.
      for (const g of groups) {
        if (g.length <= 2 && g.every((p) => p.indent < rateIndent) && !looksLikeDefinition(g[0]!.text)) {
          parent = { indent: Math.min(...g.map((p) => p.indent)), text: g.map((p) => p.text).join(' ') };
        } else {
          for (const p of g) notes.push(p.text);
        }
      }

      const parentLines: PendingLine[] = [];
      const continuation: PendingLine[] = [];
      for (const p of adjacent) {
        if (continuation.length === 0 && p.indent < rateIndent) parentLines.push(p);
        else continuation.push(p);
      }
      if (parentLines.length > 0) {
        parent = {
          indent: Math.min(...parentLines.map((p) => p.indent)),
          text: parentLines.map((p) => p.text).join(' '),
        };
      } else if (parent && rateIndent <= parent.indent) {
        parent = null;
      }

      // Text pasted without indentation: treat a leading "Heading:" line as a parent.
      if (rateIndent === 0 && parentLines.length === 0 && continuation.length > 0) {
        const first = continuation[0]!;
        if (/:\s*$/.test(first.text) && continuation.length === 1 && isChildLike(m[2]!)) {
          parent = { indent: -1, text: first.text };
          continuation.shift();
        }
      }

      const name = cleanLabel([...continuation.map((p) => p.text), m[2]!].join(' '));
      const parentText = parent ? cleanLabel(parent.text) : null;
      const label = parentText && name ? `${parentText} — ${name}` : parentText || name;
      const baseRate = Number(m[3]!.replace(/,/g, ''));
      let fringeText = m[5] ?? '';
      let eo = Boolean(m[4]);
      if (/\*\*/.test(fringeText)) {
        eo = true;
        fringeText = fringeText.replace(/\*+/g, ' ');
      }
      const occurrence = (idOccurrences.get(rateId) ?? 0) + 1;
      idOccurrences.set(rateId, occurrence);

      if (!Number.isFinite(baseRate)) {
        warnings.push(`Line ${i + 1}: could not read the rate in "${raw.trim()}".`);
      } else {
        out.push({
          key: `${rateId}#${occurrence}`,
          rateId,
          rateIdEffective: effective,
          kind,
          scope,
          parent: parentText,
          name: name || parentText || rateId,
          label: label || rateId,
          description: null,
          baseRate,
          fringe: parseFringe(fringeText),
          unit: 'hour',
          executiveOrderFlag: eo,
          line: i + 1,
        });
      }
      pending = [];
      sawBlank = false;
      continue;
    }

    if (/\.{3,}\s*\$?\s*\d/.test(raw)) {
      warnings.push(`Line ${i + 1}: a rate-like line could not be read: "${raw.trim()}".`);
    }
    pending.push({ indent: indentOf(raw), text: raw.trim(), blankBefore: sawBlank, line: i + 1 });
    sawBlank = false;
  }
  flushPendingToNotes();

  const notesText = notes.join('\n');
  const block: WDRateBlock = { rateId, effective, kind, notes: notesText, line: start + 1 };

  // Rates quoted per day (divers, some survey rates): 'Amounts in "Rates' column are per day'.
  if (PER_DAY_NOTE.test(notesText)) {
    for (const c of out) c.unit = 'day';
  }

  // Attach group definitions ("GROUP 3: Asphalt milling machine; ...") to "GROUP 3" classifications.
  const defs = parseGroupDefinitions(notes);
  if (defs.size > 0) {
    for (const c of out) {
      const g = /^group\s*(\d+)\b/i.exec(c.name);
      if (g) {
        const d = defs.get(Number(g[1]));
        if (d) c.description = d;
      }
    }
  }

  return { block, classifications: out, warnings };
}

function splitIntoGroups(pending: PendingLine[]): PendingLine[][] {
  const groups: PendingLine[][] = [];
  for (const p of pending) {
    if (groups.length === 0 || p.blankBefore) groups.push([p]);
    else groups[groups.length - 1]!.push(p);
  }
  return groups;
}

function looksLikeDefinition(text: string): boolean {
  return /^group\s*\d+\s*[:\-–]/i.test(text) || /classifications?:?$/i.test(text);
}

function isChildLike(label: string): boolean {
  return /^\s*(group|class|zone|area|tier|level|\(\d+\)|\d+[.)]?\s)/i.test(label);
}

function cleanLabel(s: string): string {
  return collapse(s)
    .replace(/[.\s]+$/g, '')
    .replace(/:\s*$/g, '')
    .replace(/^[.\s]+/g, '');
}

function parseGroupDefinitions(notes: string[]): Map<number, string> {
  const defs = new Map<number, string>();
  let current: number | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null && buffer.length) defs.set(current, collapse(buffer.join(' ')));
    current = null;
    buffer = [];
  };
  for (const line of notes) {
    const m = /^group\s*(\d+)\s*[:\-–]\s*(.*)$/i.exec(line.trim());
    if (m) {
      flush();
      current = Number(m[1]);
      buffer = [m[2]!];
    } else if (current !== null) {
      if (/classifications?:?$/i.test(line.trim())) flush();
      else buffer.push(line);
    }
  }
  flush();
  return defs;
}
