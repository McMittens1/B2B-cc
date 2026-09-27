/**
 * Worker names as payroll systems write them: "Last, First M", "First M Last",
 * "Smith, Jr., John", or a WH-347 style "Name and identifying number" cell with the
 * last four digits of the SSN appended.
 */

export interface PersonName {
  first: string;
  middle: string;
  last: string;
  suffix: string;
}

const SUFFIX = /^(?:jr|sr|ii|iii|iv|v)\.?$/i;

/** Parse a full name; a comma means "Last, First Middle". */
export function parsePersonName(text: string): PersonName {
  const clean = text.replace(/\s+/g, ' ').trim();
  const empty: PersonName = { first: '', middle: '', last: '', suffix: '' };
  if (!clean) return empty;
  const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    if (parts.length === 2 && SUFFIX.test(parts[1]!)) {
      return { ...splitGiven(parts[0]!), suffix: parts[1]! };
    }
    let suffix = '';
    let rest = parts.slice(1);
    if (rest.length > 1 && SUFFIX.test(rest[0]!)) {
      suffix = rest[0]!;
      rest = rest.slice(1);
    }
    const given = rest.join(' ').split(' ');
    if (!suffix && given.length > 1 && SUFFIX.test(given[given.length - 1]!)) suffix = given.pop()!;
    return { first: given[0] ?? '', middle: given.slice(1).join(' '), last: parts[0]!, suffix };
  }
  return splitGiven(clean);
}

function splitGiven(text: string): PersonName {
  const tokens = text.split(' ').filter(Boolean);
  let suffix = '';
  if (tokens.length > 2 && SUFFIX.test(tokens[tokens.length - 1]!)) suffix = tokens.pop()!;
  if (tokens.length === 1) return { first: '', middle: '', last: tokens[0]!, suffix };
  return { first: tokens[0] ?? '', middle: tokens.slice(1, -1).join(' '), last: tokens[tokens.length - 1] ?? '', suffix };
}

/** Display form used on payroll lines: "First Middle Last Suffix". */
export function formatPersonName(name: PersonName): string {
  return [name.first, name.middle, name.last, name.suffix].filter(Boolean).join(' ');
}

/** Normalize any written name to the display form ("Doe, Jane M" → "Jane M Doe"). */
export function displayName(text: string): string {
  return formatPersonName(parsePersonName(text));
}

const ID_TAIL = /[\s,;:#(-]+((?:[xX*\d]{3}-?[xX*\d]{2}-?\d{4})|(?:#\s*)?\d{3,})\)?\s*$/;
const ID_HEAD = /^((?:[xX*\d]{3}-[xX*\d]{2}-\d{4})|\d{3,})[\s,;:-]+/;

/**
 * Separate an identifying number written in the same cell as the name
 * ("Doe, Jane  XXX-XX-1234", "Jane Doe (4821)").
 */
export function splitNameAndId(text: string): { name: string; id: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const tail = ID_TAIL.exec(clean);
  if (tail && /[a-z]/i.test(clean.slice(0, tail.index))) {
    return { name: clean.slice(0, tail.index).replace(/[\s,;:-]+$/, ''), id: tail[1]!.replace(/^#\s*/, '') };
  }
  const head = ID_HEAD.exec(clean);
  if (head && /[a-z]/i.test(clean.slice(head[0].length))) {
    return { name: clean.slice(head[0].length), id: head[1]! };
  }
  return { name: clean, id: '' };
}

/** True when a "name" cell holds only an identifying number (the second line of an old WH-347 entry). */
export function looksLikeIdOnly(text: string): boolean {
  return /^[\sxX*#()\d-]+$/.test(text) && /\d/.test(text);
}

/** Case- and punctuation-insensitive key for deciding whether two rows name the same worker. */
export function nameKey(text: string): string {
  const p = parsePersonName(text);
  return [p.first, p.middle.slice(0, 1), p.last]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
