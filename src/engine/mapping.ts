import type { ClassificationMapping, WDClassification } from './types';
import { NOT_ON_WD } from './types';

/** Normalize a job title for matching: lowercase, strip punctuation, collapse spaces. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'and', 'or', 'the', 'of', 'a', 'an', 'in', 'on', 'to', 'for', 'with', 'all', 'including', 'includes',
  'excluding', 'only', 'work', 'workers', 'worker', 'type', 'types', 'other', 'than', 'up', 'over',
  'under', 'per', 'hour', 'cu', 'yd', 'yds',
]);

/** Common payroll shorthand mapped to the words wage determinations use. */
const SYNONYMS: Record<string, string[]> = {
  labor: ['laborer'],
  laborers: ['laborer'],
  labourer: ['laborer'],
  common: ['laborer', 'general'],
  general: ['laborer'],
  operator: ['operator', 'power', 'equipment'],
  op: ['operator'],
  opr: ['operator'],
  equip: ['equipment'],
  electrician: ['electrician', 'electricians'],
  wireman: ['electrician'],
  journeyman: [],
  journeyworker: [],
  jman: [],
  apprentice: [],
  appr: [],
  carpenter: ['carpenter', 'carpenters'],
  carp: ['carpenter'],
  plumber: ['plumber', 'plumbers', 'pipefitter'],
  pipefitter: ['pipefitter', 'plumber', 'steamfitter'],
  pipelayer: ['pipelayer', 'laborer'],
  finisher: ['finisher', 'cement', 'mason'],
  concrete: ['concrete', 'cement'],
  driver: ['driver', 'truck'],
  teamster: ['truck', 'driver'],
  cdl: ['truck', 'driver'],
  tender: ['tender'],
  iron: ['ironworker', 'ironworkers'],
  ironworker: ['ironworker', 'ironworkers'],
  roofer: ['roofer', 'roofers'],
  painter: ['painter', 'painters'],
  hvac: ['sheet', 'metal', 'pipefitter'],
  sheetmetal: ['sheet', 'metal'],
  backhoe: ['backhoe', 'excavator', 'operator'],
  excavator: ['excavator', 'backhoe', 'operator'],
  loader: ['loader', 'operator'],
  dozer: ['dozer', 'bulldozer', 'operator'],
  flagger: ['flagger', 'laborer'],
  traffic: ['traffic', 'flagger'],
};

/** Content words of wage determination text, as written. */
function docTokens(text: string): string[] {
  return normalizeLabel(text)
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}

/**
 * Content words of a payroll job title, expanded with shorthand synonyms. Only the query is
 * expanded: expanding the WD side too would let "Excavator" in one group match "backhoe".
 */
function queryTokens(text: string): string[] {
  const out: string[] = [];
  for (const t of docTokens(text)) {
    const syn = SYNONYMS[t];
    if (syn && syn.length === 0) continue; // words like "journeyman" carry no signal
    out.push(t, ...(syn ?? []));
  }
  return out;
}

function stem(t: string): string {
  return t.length > 4 ? t.replace(/(ers|er|ors|or|s)$/, '') : t;
}

export interface MappingSuggestion {
  classification: WDClassification;
  score: number;
  reason: string;
}

/**
 * Rank wage determination classifications for a payroll job title. Uses word overlap
 * against the classification label, its parent heading, and group definitions (so
 * "Backhoe operator" finds "OPERATOR: Power Equipment — GROUP 2" when group 2 lists backhoes).
 */
export function suggestClassifications(
  payrollLabel: string,
  classifications: readonly WDClassification[],
  limit = 5,
): MappingSuggestion[] {
  const q = queryTokens(payrollLabel).map(stem);
  if (q.length === 0) return [];
  const qSet = new Set(q);
  const normQuery = normalizeLabel(payrollLabel);
  const results: MappingSuggestion[] = [];
  for (const c of classifications) {
    const labelTokens = new Set(docTokens(c.label).map(stem));
    const descTokens = new Set(c.description ? docTokens(c.description).map(stem) : []);
    let labelHits = 0;
    let descHits = 0;
    for (const t of qSet) {
      if (labelTokens.has(t)) labelHits++;
      else if (descTokens.has(t)) descHits++;
    }
    if (labelHits === 0 && descHits === 0) continue;
    let score = (labelHits * 2 + descHits) / (qSet.size * 2);
    // Prefer tight labels: penalize long labels that only share one word.
    score *= 1 / (1 + Math.max(0, labelTokens.size - labelHits) * 0.04);
    const normName = normalizeLabel(c.name);
    const normLabel = normalizeLabel(c.label);
    if (normName === normQuery || normLabel === normQuery) score += 1;
    const reason =
      descHits > 0 && labelHits === 0
        ? 'matches group definition'
        : descHits > 0
          ? 'matches label and group definition'
          : 'matches label';
    results.push({ classification: c, score, reason });
  }
  results.sort((a, b) => b.score - a.score || a.classification.line - b.classification.line);
  return results.slice(0, limit);
}

/**
 * Resolve a payroll line's classification to a WD classification key.
 * Order: explicit mapping for this contractor → unique exact label match on the WD.
 */
export function resolveClassification(
  payrollLabel: string,
  contractorId: string,
  mappings: readonly ClassificationMapping[],
  classifications: readonly WDClassification[],
): { key: string | null; source: 'mapping' | 'exact' | 'none' } {
  const norm = normalizeLabel(payrollLabel);
  const explicit = mappings.find((m) => m.contractorId === contractorId && m.payrollLabel === norm);
  if (explicit) return { key: carryForwardKey(explicit.classificationKey, classifications), source: 'mapping' };
  if (norm === '') return { key: null, source: 'none' };
  const exact = classifications.filter(
    (c) => normalizeLabel(c.label) === norm || normalizeLabel(c.name) === norm,
  );
  if (exact.length === 1) return { key: exact[0]!.key, source: 'exact' };
  return { key: null, source: 'none' };
}

/**
 * A saved match whose classification is no longer on the WD (a later modification renumbered
 * the rate identifier, e.g. ELEC0001-005 to ELEC0001-006) follows the classification with the
 * same label and rate identifier family, when there is exactly one.
 */
function carryForwardKey(key: string, classifications: readonly WDClassification[]): string {
  if (key === NOT_ON_WD || classifications.some((c) => c.key === key)) return key;
  const [rateId = '', slug = ''] = key.split('#');
  if (!slug) return key;
  const family = rateId.split('-')[0];
  const candidates = classifications.filter((c) => {
    const [cRateId = '', cSlug = ''] = c.key.split('#');
    return cSlug === slug && cRateId.split('-')[0] === family;
  });
  return candidates.length === 1 ? candidates[0]!.key : key;
}

export function isNotOnWd(key: string | null): boolean {
  return key === NOT_ON_WD;
}
