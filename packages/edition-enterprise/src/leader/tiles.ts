import { DomainError } from '@machvon/kernel';

/**
 * The tile "projects blocked on procedure" of the leadership dashboard (ENT-4d, HSKT CN.03 and BC.02, DIR.md section 12 R2). A project is blocked on procedure when a procedure that decides whether it can go on is
 * past its day: a permit whose decision was expected and has not come (PMT), an issue not solved past its due day (ISS), compensation of the land cleared that was due and is not paid (LND), a procurement package that has
 * had no activity for the days the rule allows (BID). The count is of projects, not of items, so a project with three late permits is one; the list says which sources hold it and since when. The facts are read by the
 * store in the scope of the reader; this module is the arithmetic: pure, no clock, no database. A tile that cannot be given says why and is never 0.
 */

export const BLOCK_SOURCES = ['PERMIT', 'ISSUE', 'LAND', 'PROCUREMENT'] as const;
export type BlockSource = (typeof BLOCK_SOURCES)[number];

/** Days a procurement package may rest without activity before the project is counted as blocked: configuration, flagged unverified until the owner of the process signs it. */
export const BLOCKED_STALLED_DAYS_DEFAULT = 14;
export const BLOCKED_DEFINITION_STATUS = 'PROPOSED_PENDING_SIGNOFF';
/** How many projects the list of the tile gives; the count is always the whole. */
export const BLOCKED_LIST_LIMIT = 50;

/** One thing that holds a project: the day it began to hold (the due day, the idle day), as `YYYY-MM-DD`. */
export interface BlockFact {
  projectId: string;
  projectCode: string;
  projectName: string;
  unitId: string | null;
  unitName: string | null;
  source: BlockSource;
  sourceId: string;
  since: string;
}

export interface BlockedProject {
  projectId: string;
  projectCode: string;
  projectName: string;
  unitId: string | null;
  unitName: string | null;
  /** The sources that hold the project, in the order of `BLOCK_SOURCES`. */
  sources: BlockSource[];
  items: number;
  /** The earliest day any of its holds began, and the days from then to today. */
  since: string;
  days: number;
}

export interface BlockedBoard {
  asOf: string;
  total: number;
  /** Projects blocked, by source (a project held by two sources counts in both). */
  bySource: Record<BlockSource, number>;
  projects: BlockedProject[];
  truncated: boolean;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dayNumber(day: string, field: string): number {
  const match = DAY.exec(day);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, field);
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(value).toISOString().slice(0, 10) !== day) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

export const daysFrom = (since: string, today: string): number => Math.round((dayNumber(today, 'today') - dayNumber(since, 'since')) / DAY_MS);

/**
 * The board: facts whose day is not before today are not holds yet (a decision due today is not late until the day is over), the rest group by project. The order is the longest hold first, then the code, so the list is
 * the same however the store read the facts.
 */
export function blockedBoard(facts: readonly BlockFact[], today: string, limit: number = BLOCKED_LIST_LIMIT): BlockedBoard {
  dayNumber(today, 'today');
  const projects = new Map<string, { head: BlockFact; sources: Set<BlockSource>; items: number; since: string }>();
  const seen = new Set<string>();
  for (const fact of facts) {
    if (daysFrom(fact.since, today) <= 0) continue;
    // The same thing read twice (two joins that meet) is one hold.
    const key = `${fact.source}:${fact.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = projects.get(fact.projectId);
    if (entry === undefined) projects.set(fact.projectId, { head: fact, sources: new Set([fact.source]), items: 1, since: fact.since });
    else {
      entry.sources.add(fact.source);
      entry.items += 1;
      if (fact.since < entry.since) entry.since = fact.since;
    }
  }
  const bySource: Record<BlockSource, number> = { PERMIT: 0, ISSUE: 0, LAND: 0, PROCUREMENT: 0 };
  const all: BlockedProject[] = [...projects.values()].map((entry) => {
    for (const source of entry.sources) bySource[source] += 1;
    return {
      projectId: entry.head.projectId,
      projectCode: entry.head.projectCode,
      projectName: entry.head.projectName,
      unitId: entry.head.unitId,
      unitName: entry.head.unitName,
      sources: BLOCK_SOURCES.filter((source) => entry.sources.has(source)),
      items: entry.items,
      since: entry.since,
      days: daysFrom(entry.since, today),
    };
  });
  all.sort((a, b) => b.days - a.days || a.projectCode.localeCompare(b.projectCode, 'en') || a.projectId.localeCompare(b.projectId, 'en'));
  return { asOf: today, total: all.length, bySource, projects: all.slice(0, limit), truncated: all.length > limit };
}

/** What each source means, for the "i" of the tile (the words are in the web catalogue; this is the formula the API states). */
export const BLOCKED_FORMULA = 'count of projects with at least one hold: permit decision expected before today and not given; issue not solved past its due day; compensation due before today and not paid; procurement package idle for the stalled days';
