import { CATEGORIES, ORIGINS, categoryOf, isPublished, sumVnd, toAppropriation } from '../cap/model';
import type { AppropriationLine, Category, Origin } from '../cap/model';

/** The categories that stand as cards of their own, in the order of the screen; CTMTQG is not one: it is part of its parent (HOME 3 F6). */
export const SOURCE_CATEGORIES: readonly Category[] = CATEGORIES.filter((category) => category !== 'CTMTQG');
/** The categories that are always drawn, as a card with "no data" when nothing is published for them; the rest is drawn only when it has capital. */
const ALWAYS_DRAWN: readonly Category[] = ['NSTW', 'NSDP', 'ODA'];
/** The category that holds CTMTQG as a part of it. */
export const SUBSET_PARENT: Category = 'NSTW';

const VND = /^(0|[1-9]\d*)$/;
const BILLION = 1_000_000_000n;
const BILLION_FRACTION = 10_000_000n; // two decimals of a billion

/** An appropriation of the register, as the funding structure reads it. */
export type FundingRow = AppropriationLine;

export const toFundingRow = (raw: unknown): FundingRow | undefined => toAppropriation(raw);

/** Whether a fund source is a part of another one: what it holds is inside its parent and is never added to it. */
export const isSubsetSource = (row: AppropriationLine): boolean => row.fundSource.relation === 'SUBSET_OF' || categoryOf(row.fundSource) === 'CTMTQG';

/**
 * The part that is CTMTQG of each appropriation, from the allocation lines of the published plans: the amount of a line already holds its CTMTQG part,
 * so the part is read from the line and never added to it. Every appropriation is in the answer when the lines were read (one that no published line
 * draws on has a known part of zero); when they could not be read (`lines` is undefined) the answer is empty, so nothing is known, and "nothing" is not zero.
 */
export function ctmtqgAmounts(rows: readonly FundingRow[], lines: readonly unknown[] | undefined): Map<string, string> {
  const amounts = new Map<string, string>();
  if (lines === undefined) return amounts;
  for (const row of rows) amounts.set(row.id, '0');
  for (const raw of lines) {
    const line = raw as { plan_status?: unknown; appropriation?: { id?: unknown } | null; ctmtqg_subset_vnd?: unknown };
    const appropriation = line.appropriation?.id;
    const inside = line.ctmtqg_subset_vnd;
    if (line.plan_status !== 'PUBLISHED' || typeof appropriation !== 'string' || typeof inside !== 'string' || !VND.test(inside) || !amounts.has(appropriation)) continue;
    amounts.set(appropriation, sumVnd([amounts.get(appropriation) ?? '0', inside]));
  }
  return amounts;
}

/** What is known of the part that is CTMTQG: the amount, or none when nothing is known, and whether some appropriation of the card could not be read. */
export interface SubsetFigure {
  vnd: string | null;
  partial: boolean;
}

export interface SourceCard {
  category: Category;
  /** The capital published for the source, or none when there is none: "no data", never zero. */
  vnd: string | null;
  count: number;
  /** Only the parent of CTMTQG has one. */
  subset: SubsetFigure | null;
}

export interface OriginCard {
  origin: Origin;
  vnd: string | null;
  count: number;
}

export interface DetailRow {
  key: string;
  /** The label of the fund source. */
  label: string;
  category: Category;
  origin: Origin | null;
  vnd: string;
  /** A part of its parent: shown, and not added. */
  subsetOf: Category | null;
  /** The day the decision that gave the capital was issued: the cut-off of the figure. */
  cutOff: string | null;
  planYear: number;
}

export interface Funding {
  year: number;
  /** What is added: the published capital that is not a part of another source. None when there is none. */
  totalVnd: string | null;
  sources: SourceCard[];
  origins: OriginCard[];
  rows: DetailRow[];
}

const part = (amount: string | undefined): string => (amount === undefined || !VND.test(amount) ? '0' : amount);
const total = (rows: readonly AppropriationLine[]): string | null => (rows.length === 0 ? null : sumVnd(rows.map((row) => row.amountVnd)));

/** The years that have capital published, the newest first: the options of the year, and the first one is the one the screen opens on. */
export function fundingYears(rows: readonly AppropriationLine[]): number[] {
  return [...new Set(rows.filter(isPublished).map((row) => row.planYear))].sort((a, b) => b - a);
}

/**
 * The funding structure of a year (HOME 3 F6): the published appropriations by source and by origin, each card with the amount that was published
 * or none; CTMTQG is shown as a part of its parent, from the lines of the plans, and is in no total. A source that is a part of another one
 * (CTMTQG registered as a source of its own) is a row of the detail and a part of the parent card, never an addition to it.
 */
export function fundingOf(rows: readonly FundingRow[], year: number, subsets: ReadonlyMap<string, string>): Funding {
  const published = rows.filter((row) => isPublished(row) && row.planYear === year);
  const additive = published.filter((row) => !isSubsetSource(row));
  const registeredParts = published.filter(isSubsetSource);
  const sources: SourceCard[] = SOURCE_CATEGORIES.flatMap((category) => {
    const own = additive.filter((row) => categoryOf(row.fundSource) === category);
    if (own.length === 0 && !ALWAYS_DRAWN.includes(category)) return [];
    return [{ category, vnd: total(own), count: own.length, subset: category === SUBSET_PARENT ? subsetFigure(own, registeredParts, subsets) : null }];
  });
  const origins: OriginCard[] = ORIGINS.map((origin) => {
    const own = additive.filter((row) => row.origin === origin);
    return { origin, vnd: total(own), count: own.length };
  });
  return { year, totalVnd: total(additive), sources, origins, rows: detailRows(additive, registeredParts, subsets) };
}

function subsetFigure(parents: readonly FundingRow[], registered: readonly FundingRow[], subsets: ReadonlyMap<string, string>): SubsetFigure {
  const known = parents.filter((row) => subsets.has(row.id));
  if (known.length === 0 && registered.length === 0) return { vnd: null, partial: false };
  return { vnd: sumVnd([...known.map((row) => part(subsets.get(row.id))), ...registered.map((row) => row.amountVnd)]), partial: known.length < parents.length };
}

const compareRows = (a: FundingRow, b: FundingRow): number =>
  CATEGORIES.indexOf(categoryOf(a.fundSource)) - CATEGORIES.indexOf(categoryOf(b.fundSource)) ||
  ORIGINS.indexOf(a.origin) - ORIGINS.indexOf(b.origin) ||
  a.fundSource.businessKey.localeCompare(b.fundSource.businessKey) ||
  a.id.localeCompare(b.id);

/** The rows of HOME-08: each published appropriation, and under it the part of it that is CTMTQG (when it has one), which says it is a part and is not counted. */
function detailRows(additive: readonly FundingRow[], registered: readonly FundingRow[], subsets: ReadonlyMap<string, string>): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const row of [...additive].sort(compareRows)) {
    const category = categoryOf(row.fundSource);
    rows.push({ key: row.id, label: row.fundSource.label, category, origin: row.origin, vnd: row.amountVnd, subsetOf: null, cutOff: row.decisionIssuedOn, planYear: row.planYear });
    const inside = part(subsets.get(row.id));
    if (category === SUBSET_PARENT && inside !== '0') rows.push({ key: `${row.id}:ctmtqg`, label: row.fundSource.label, category: 'CTMTQG', origin: row.origin, vnd: inside, subsetOf: SUBSET_PARENT, cutOff: row.decisionIssuedOn, planYear: row.planYear });
  }
  for (const row of [...registered].sort(compareRows)) {
    rows.push({ key: row.id, label: row.fundSource.label, category: categoryOf(row.fundSource), origin: row.origin, vnd: row.amountVnd, subsetOf: SUBSET_PARENT, cutOff: row.decisionIssuedOn, planYear: row.planYear });
  }
  return rows;
}

/** An amount of whole VND in billions of dong, to two decimals and never rounded up (so a card never says more than was published); the exact amount is shown beside it. */
export function billionsText(vnd: string, locale: string): string {
  if (!VND.test(vnd)) return vnd;
  const value = BigInt(vnd);
  const fraction = ((value % BILLION) / BILLION_FRACTION).toString().padStart(2, '0').replace(/0+$/, '');
  const mark = new Intl.NumberFormat(locale).formatToParts(1.1).find((piece) => piece.type === 'decimal')?.value ?? '.';
  const grouped = new Intl.NumberFormat(locale).format(value / BILLION);
  return fraction === '' ? grouped : `${grouped}${mark}${fraction}`;
}
