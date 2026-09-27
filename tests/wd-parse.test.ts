import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseWageDetermination } from '../src/engine/wd/parse';
import { parseFringe, requiredFringe } from '../src/engine/wd/fringe';

const load = (name: string) => fs.readFileSync(`fixtures/wd/${name}`, 'utf8');
const byLine = (wd: ReturnType<typeof parseWageDetermination>, rateId: string) =>
  wd.classifications.filter((c) => c.rateId === rateId);

describe('parseFringe', () => {
  it.each([
    ['21.45', 21.45, 0, []],
    ['6.915', 6.915, 0, []],
    ['.15+a', 0.15, 0, ['a']],
    ['12.00+a', 12, 0, ['a']],
    ['3%+21.00', 21, 3, []],
    ['3.5%+3.25', 3.25, 3.5, []],
    ['7.85 + 3%', 7.85, 3, []],
    ['21.785+A+B', 21.785, 0, ['a', 'b']],
    ['7.455+A&B', 7.455, 0, ['a', 'b']],
    ['25%', 0, 25, []],
    ['', 0, 0, []],
  ])('%s', (raw, fixed, percent, footnotes) => {
    const f = parseFringe(raw);
    expect(f.fixed).toBeCloseTo(fixed, 6);
    expect(f.percent).toBeCloseTo(percent, 6);
    expect(f.footnotes).toEqual(footnotes);
    expect(f.raw).toBe(raw.trim());
  });

  it('computes percentage fringes from the basic rate', () => {
    expect(requiredFringe(parseFringe('3%+21.00'), 44)).toBeCloseTo(22.32, 6);
    expect(requiredFringe(parseFringe('4%+5.33'), 18.8)).toBeCloseTo(6.082, 6);
  });
});

describe('parseWageDetermination — real SAM.gov/WDOL layouts', () => {
  it('reads the header, modifications and multi-line classification names (CA140001)', () => {
    const wd = parseWageDetermination(load('wd1.txt'));
    expect(wd.decisionNumber).toBe('CA140001');
    expect(wd.decisionDate).toBe('2014-12-05');
    expect(wd.supersededDecision).toBe('CA20130001');
    expect(wd.state).toBe('California');
    expect(wd.currentModification).toBe(17);
    expect(wd.modifications).toHaveLength(18);
    expect(wd.warnings).toEqual([]);
    expect(wd.classifications).toHaveLength(145);

    const asb = byLine(wd, 'ASBE0005-002');
    expect(asb[0]!.label).toMatch(/^Asbestos Workers\/Insulator \(Includes the application of all insulating materials/);
    expect(asb[0]!.baseRate).toBe(35.44);
    expect(asb[0]!.fringe.fixed).toBe(19.36);
    expect(asb[0]!.unit).toBe('hour');
  });

  it('marks only the diver block as per-day and nests "(1) Wet" under "Diver"', () => {
    const wd = parseWageDetermination(load('wd1.txt'));
    const divers = byLine(wd, 'CARP0409-002');
    expect(divers.map((c) => c.label)).toEqual([
      'Diver — (1) Wet',
      'Diver — (2) Standby',
      'Diver — (3) Tender',
      'Diver — (4) Assistant Tender',
    ]);
    expect(divers.every((c) => c.unit === 'day')).toBe(true);
    expect(wd.classifications.filter((c) => c.unit === 'day')).toHaveLength(4);
  });

  it('reads county scopes, grouped rates and group definitions (IL100001)', () => {
    const wd = parseWageDetermination(load('wd9.txt'));
    expect(wd.decisionNumber).toBe('IL100001');
    expect(wd.currentModification).toBe(36);
    expect(wd.warnings).toEqual([]);
    const lab = byLine(wd, 'LABO0149-003');
    expect(lab).toHaveLength(8);
    expect(lab.every((c) => c.parent === 'LABORER' && c.scope === 'BOONE COUNTY')).toBe(true);
    expect(lab[0]!.label).toBe('LABORER — GROUP 1');
    expect(lab[0]!.baseRate).toBe(35.2);
    expect(lab[0]!.description).toBe('Common Laborer, Bobcat, Forklift');
    expect(lab[7]!.description).toMatch(/^Asbestos Abatement Laborers/);

    const elevator = wd.classifications.find((c) => c.label === 'ELEVATOR MECHANIC' && c.fringe.raw === '7.455+A&B');
    expect(elevator?.fringe.footnotes).toEqual(['a', 'b']);
    expect(elevator?.fringe.fixed).toBeCloseTo(7.455, 6);
  });

  it('does not read premium-pay notes as classifications', () => {
    const wd = parseWageDetermination(load('wd9.txt'));
    expect(wd.classifications.some((c) => /premium pay|long boom/i.test(c.label))).toBe(false);
    expect(wd.classifications.some((c) => c.baseRate < 5)).toBe(false);
  });

  it('nests survey classifications under "Carpenters:" style headings (CA170005)', () => {
    const wd = parseWageDetermination(load('wd0.txt'));
    expect(wd.decisionNumber).toBe('CA170005');
    expect(wd.warnings).toEqual([]);
    const labels = wd.classifications.map((c) => c.label);
    expect(labels).toContain('Carpenters — Carpenter');
    expect(labels).toContain('Carpenters — Millwright');
    expect(labels).toContain('Drywall Installers/Lathers — Drywall stocker, scrapper & clean-up');
    const splicer = wd.classifications.find((c) => c.label === 'Electricians — Cable Splicer');
    expect(splicer?.fringe).toMatchObject({ fixed: 5.53, percent: 3 });
    expect(wd.classifications.every((c) => c.kind === 'survey')).toBe(true);
    expect(wd.classifications.every((c) => c.unit === 'hour')).toBe(true);
  });

  it('accepts single-dot leaders when a label fills the line (NM170001, VA150001)', () => {
    const nm = parseWageDetermination(load('wd3.txt'));
    expect(nm.classifications.some((c) => c.baseRate === 10.81)).toBe(true);
    const va = parseWageDetermination(load('wd4.txt'));
    expect(va.classifications.some((c) => /Spider\/Spill Barge Operator/.test(c.label))).toBe(true);
    expect(va.warnings).toEqual([]);
  });

  it('parses every real fixture without warnings, and duplicates parse identically', () => {
    for (const f of ['wd0.txt', 'wd1.txt', 'wd3.txt', 'wd4.txt', 'wd6.txt', 'wd7.txt', 'wd8.txt', 'wd9.txt']) {
      const wd = parseWageDetermination(load(f));
      expect(wd.warnings, f).toEqual([]);
      expect(wd.classifications.length, f).toBeGreaterThan(10);
      const keys = new Set(wd.classifications.map((c) => c.key));
      expect(keys.size, `${f} keys unique`).toBe(wd.classifications.length);
      for (const c of wd.classifications) {
        expect(c.baseRate, `${f}:${c.line}`).toBeGreaterThan(0);
        expect(c.label.length, `${f}:${c.line}`).toBeGreaterThan(1);
      }
    }
    expect(parseWageDetermination(load('wd5.txt'))).toEqual(parseWageDetermination(load('wd1.txt')));
  });

  it('reports a fragment without rate identifiers instead of guessing', () => {
    const wd = parseWageDetermination(load('wd2.txt'));
    expect(wd.classifications).toHaveLength(0);
    expect(wd.warnings.join(' ')).toMatch(/No rate identifiers/);
    expect(wd.warnings.join(' ')).toMatch(/General Decision Number not found/);
  });
});

describe('parseWageDetermination — current layout (sample)', () => {
  const wd = parseWageDetermination(load('sample-modern.txt'));

  it('reads the header even with the quote characters SAM.gov copies include', () => {
    expect(wd.decisionNumber).toBe('XX20260047');
    expect(wd.decisionDate).toBe('2026-03-06');
    expect(wd.currentModification).toBe(2);
    expect(wd.counties).toBe('Harlow and Pine Counties in Sample State.');
    expect(wd.warnings).toEqual([]);
  });

  it('lists all classifications with parents, groups, footnotes and markers', () => {
    expect(wd.classifications.map((c) => c.label)).toEqual([
      'CARPENTER (Including Form Work)',
      'ELECTRICIAN',
      'POWER EQUIPMENT OPERATOR — GROUP 1',
      'POWER EQUIPMENT OPERATOR — GROUP 2',
      'POWER EQUIPMENT OPERATOR — GROUP 3',
      'LABORER — GROUP 1',
      'LABORER — GROUP 2',
      'PLUMBER/PIPEFITTER',
      'CEMENT MASON/CONCRETE FINISHER',
      'TRUCK DRIVER: Dump Truck',
      'DIVER (Commercial)',
    ]);
    const op2 = wd.classifications[3]!;
    expect(op2.description).toBe('Backhoe; Excavator; Loader; Dozer; Grader; Trencher; Skid Steer over 1 cu. yd.');
    const mason = wd.classifications[8]!;
    expect(mason.executiveOrderFlag).toBe(true);
    expect(mason.kind).toBe('survey');
    expect(mason.fringe.fixed).toBe(6.12);
    expect(wd.classifications[7]!.fringe.footnotes).toEqual(['a']);
    expect(wd.classifications[10]!.unit).toBe('day');
    expect(wd.generalNotes).toMatch(/WELDERS/);
    expect(wd.generalNotes).toMatch(/Executive Order 13658/);
  });

  it('still finds every rate when indentation was lost in a paste', () => {
    const flat = load('sample-modern.txt')
      .split('\n')
      .map((l) => l.trimStart())
      .join('\n');
    const parsed = parseWageDetermination(flat);
    expect(parsed.classifications.map((c) => c.baseRate)).toEqual(wd.classifications.map((c) => c.baseRate));
  });
});
