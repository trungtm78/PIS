import type { components } from '@machvon/contracts';
import type { TimelineGroup, Tone } from '../../../ui';
import { vietnamDay } from '../shared/vnd-model';

export { dayText, numberText, percentText, vietnamStamp } from '../shared/vnd-model';

/** VND-13, VND-14, VND-15 and VND-22: the investigation of contractors (V6), the screening against the lists of banned parties (V14), the disputes and the OCDS export (V16, V18). The shapes are the contract's. */
type S = components['schemas'];
export type LeadLine = S['VendorLeadLine'];
export type LeadPage = S['VendorLeadPage'];
export type LeadDetail = S['VendorLeadDetail'];
export type LeadSignal = S['VendorLeadSignal'];
export type LeadContractor = S['VendorLeadContractor'];
export type LeadLink = S['VendorLeadLink'];
export type LeadEvent = S['VendorLeadEvent'];
export type LinkGraphAnswer = S['VendorLinkGraph'];
export type LinkNode = S['VendorLinkNode'];
export type LinkEvidence = S['VendorLinkEvidence'];
export type InvestigationFigures = S['VendorInvestigationFigures'];
export type HitLine = S['VendorScreeningHitLine'];
export type HitDetail = S['VendorScreeningHitDetail'];
export type HitEvent = S['VendorScreeningEvent'];
export type ScreeningOverview = S['VendorScreeningOverview'];
export type ScreeningRun = S['VendorScreeningRun'];
export type DisputeLine = S['VendorDisputeLine'];
export type DisputeStats = S['VendorDisputeStats'];
export type Disputes = S['VendorDisputes'];
export type OcdsExport = S['VendorOcdsExport'];
export type Policy = S['VendorInvPolicyInfo'];
export type LeadKind = LeadLine['kind'];
export type LeadStatus = LeadLine['status'];
export type LinkKind = LinkEvidence['kind'];
export type HitSource = HitLine['source'];
export type HitStatus = HitLine['status'];
export type ListSource = S['VendorScreeningImportRequest']['source'];
export type ListEntry = S['VendorScreeningImportRequest']['entries'][number];

/** The permissions of the lane (the server decides every one of them again). */
export const INV_PERMISSION = {
  leadRead: 'vnd.lead.read',
  leadReview: 'vnd.lead.review',
  leadConfirm: 'vnd.lead.confirm',
  leadScan: 'vnd.lead.scan',
  screeningRead: 'vnd.screening.read',
  screeningRun: 'vnd.screening.run',
  screeningDecide: 'vnd.screening.decide',
  screeningImport: 'vnd.screening.import',
  ocdsExport: 'vnd.ocds.export',
} as const;

export const LEAD_KINDS: readonly LeadKind[] = ['LINK_CLUSTER', 'RESTRICTED_AFFILIATE', 'ROTATING_WINNERS', 'COVER_BID', 'PRICE_PATTERN', 'FILE_METADATA', 'SHARED_ORIGIN', 'WITHDRAWAL_FOR_WINNER'];
export const LEAD_STATUSES: readonly LeadStatus[] = ['NEW', 'IN_REVIEW', 'DISMISS_PROPOSED', 'DISMISSED', 'CONFIRMED', 'REFERRED'];
export const LINK_KINDS: readonly LinkKind[] = ['TAX_HEAD', 'BANK_ACCOUNT', 'LEGAL_REPRESENTATIVE', 'OWNER', 'ADDRESS', 'PHONE', 'EMAIL', 'SUBMISSION_ORIGIN', 'SUBMISSION_DEVICE', 'FILE_AUTHOR'];
export const HIT_SOURCES: readonly HitSource[] = ['NATIONAL_DEBARMENT', 'WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST'];
export const LIST_SOURCES: readonly ListSource[] = ['WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST'];
export const HIT_STATUSES: readonly HitStatus[] = ['PENDING', 'CONFIRMED', 'DISMISSED', 'RESOLVED'];
export const HIT_BASES = ['TAX_CODE', 'TAX_HEAD', 'NAME'] as const;
export const PAGE_SIZE = 25;

export const INV_PATHS = {
  leads: '/vnd/vnd-13',
  lead: (id: string): string => `/vnd/vnd-14?lead=${encodeURIComponent(id)}`,
  screening: '/vnd/vnd-15',
  hit: (id: string): string => `/vnd/vnd-15?hit=${encodeURIComponent(id)}`,
  disputes: (contractor?: string): string => (contractor === undefined ? '/vnd/vnd-22' : `/vnd/vnd-22?contractor=${encodeURIComponent(contractor)}`),
} as const;

// ---- tones -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const LEAD_TONE: Readonly<Record<LeadStatus, Tone>> = { NEW: 'info', IN_REVIEW: 'info', DISMISS_PROPOSED: 'warning', DISMISSED: 'neutral', CONFIRMED: 'danger', REFERRED: 'danger' };
export const leadTone = (status: LeadStatus): Tone => LEAD_TONE[status];

/** The rank of a lead as a tone: it orders the work, it is not a verdict, so the tone only says where to look first. */
export const rankTone = (rank: number): Tone => (rank >= 80 ? 'danger' : rank >= 60 ? 'warning' : 'info');

const HIT_TONE: Readonly<Record<HitStatus, Tone>> = { PENDING: 'warning', CONFIRMED: 'danger', DISMISSED: 'neutral', RESOLVED: 'success' };
export const hitTone = (status: HitStatus): Tone => HIT_TONE[status];

/** A lead that still waits for an auditor (not decided): the list marks it with the severity stripe. */
export const leadOpen = (status: LeadStatus): boolean => status === 'NEW' || status === 'IN_REVIEW' || status === 'DISMISS_PROPOSED';

/** The share of bids that have a recorded origin or device and the share that have a file fingerprint, in whole percent; none when there are no bids. */
export function traceShares(trace: { bids: number; with_origin: number; with_files: number }): { origin: number | null; files: number | null } {
  if (trace.bids <= 0) return { origin: null, files: null };
  return { origin: Math.round((trace.with_origin * 100) / trace.bids), files: Math.round((trace.with_files * 100) / trace.bids) };
}

// ---- the drawing of a graph: no library, so the numbers are made here and the same input gives the same picture ------------------------------------------------------

export const GRAPH_WIDTH = 560;
export const GRAPH_HEIGHT = 420;
export const NODE_RADIUS = 22;

/** The thickness of an edge by its strength: one to six pixels, never zero, so that a weak link is still seen. */
export const edgeWidth = (strength: number): number => 1 + Math.round(Math.max(0, Math.min(100, strength)) / 20);

/** A name cut for a label under a node; the whole name is in the table and in the accessible name. */
export function shortName(name: string, limit = 18): string {
  const chars = Array.from(name);
  return chars.length <= limit ? name : `${chars.slice(0, limit - 1).join('')}…`;
}

export interface DrawnNode {
  id: string;
  x: number;
  y: number;
  name: string;
  tax: string;
  restricted: boolean;
  focus: boolean;
  cluster: number | null;
}

export interface DrawnEdge {
  key: string;
  a: string;
  b: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number;
  my: number;
  strength: number;
  width: number;
  stale: boolean;
  kinds: LinkKind[];
}

export interface DrawnGraph {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
}

interface Place {
  id: string;
  x: number;
  y: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The places of the members: the focus in the middle (when it is a member), the others on a circle in the order of the strength of their link to it, then by id. The same input gives the same drawing.
 */
function radialLayout(members: readonly string[], links: readonly LeadLink[], focusId: string | null, width: number, height: number): Place[] {
  const centre = focusId !== null && members.includes(focusId) ? focusId : null;
  const strength = (id: string): number => (centre === null ? 0 : (links.find((link) => (link.a_id === centre && link.b_id === id) || (link.b_id === centre && link.a_id === id))?.strength ?? 0));
  const ring = members.filter((id) => id !== centre).sort((x, y) => strength(y) - strength(x) || (x < y ? -1 : 1));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 36;
  const places: Place[] = [];
  if (centre !== null) places.push({ id: centre, x: round1(cx), y: round1(cy) });
  ring.forEach((id, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, ring.length);
    places.push({ id, x: round1(cx + radius * Math.cos(angle)), y: round1(cy + radius * Math.sin(angle)) });
  });
  return places;
}

/**
 * The drawing: the members are laid out here (the focus in the middle, the others on a circle by the strength of their link to it), this adds the edges with their thickness and the middle of each edge for its label.
 * A link to a contractor that is not among the nodes is left out of the drawing (it stays in the table).
 */
export function drawGraph(nodes: readonly LinkNode[], links: readonly LeadLink[], focusId: string | null, width = GRAPH_WIDTH, height = GRAPH_HEIGHT): DrawnGraph {
  const placed = radialLayout(
    nodes.map((node) => node.id),
    links,
    focusId,
    width,
    height,
  );
  const at = new Map(placed.map((node) => [node.id, node]));
  const drawn: DrawnNode[] = [];
  for (const node of nodes) {
    const spot = at.get(node.id);
    if (spot === undefined) continue;
    drawn.push({ id: node.id, x: spot.x, y: spot.y, name: node.name, tax: node.tax_identifier, restricted: node.restricted, focus: node.id === focusId, cluster: node.cluster });
  }
  const edges: DrawnEdge[] = [];
  for (const link of links) {
    const from = at.get(link.a_id);
    const to = at.get(link.b_id);
    if (from === undefined || to === undefined) continue;
    edges.push({
      key: `${link.a_id}:${link.b_id}`,
      a: link.a_id,
      b: link.b_id,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      mx: round1((from.x + to.x) / 2),
      my: round1((from.y + to.y) / 2),
      strength: link.strength,
      width: edgeWidth(link.strength),
      stale: link.status === 'STALE',
      kinds: link.evidence.map((entry) => entry.kind),
    });
  }
  return { nodes: drawn, edges };
}

/** The nodes of a lead's graph from the contractors the lead names (a lead carries its own contractors and links). */
export function nodesOfLead(contractors: readonly { id: string; name: string; tax_identifier: string; restricted: boolean }[]): LinkNode[] {
  return contractors.map((contractor) => ({ id: contractor.id, name: contractor.name, tax_identifier: contractor.tax_identifier, restricted: contractor.restricted, cluster: null }));
}

/** The links that touch one contractor, strongest first (the table under the graph and the detail of a selected node). */
export function linksOf(links: readonly LeadLink[], id: string): LeadLink[] {
  return links.filter((link) => link.a_id === id || link.b_id === id).sort((x, y) => y.strength - x.strength || (x.a_id + x.b_id < y.a_id + y.b_id ? -1 : 1));
}

// ---- the history of a lead as a timeline ----------------------------------------------------------------------------------------------------------------------------------

/** The entries of a lead's history grouped by the Vietnam day, newest day first; the text of the title is the caller's (it is already translated). */
export function historyGroups(events: readonly LeadEvent[], title: (event: LeadEvent) => string): TimelineGroup[] {
  const byDay = new Map<string, LeadEvent[]>();
  for (const event of events) {
    const day = vietnamDay(event.at);
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  return [...byDay.entries()]
    .sort(([x], [y]) => (x < y ? 1 : x > y ? -1 : 0))
    .map(([date, list]) => ({
      date,
      entries: list.map((event) => ({
        id: event.id,
        at: event.at,
        kind: 'transition' as const,
        title: title(event),
        actor: event.actor_name === null ? null : { name: event.actor_name, initials: initialsOf(event.actor_name) },
        ...(event.reason === null ? {} : { note: event.reason }),
      })),
    }));
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

// ---- a list of entries pasted for import ------------------------------------------------------------------------------------------------------------------------------------

export type EntryProblem = 'EMPTY' | 'JSON' | 'TOO_MANY' | 'REF' | 'LENGTH' | 'DAY' | 'IDENTITY' | 'PERIOD';

export interface EntryError {
  /** The line of the text (CSV) or the position in the array (JSON), counted from 1. */
  line: number;
  problem: EntryProblem;
}

export interface ParsedEntries {
  entries: ListEntry[];
  errors: EntryError[];
}

export const MAX_ENTRIES = 5000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

function entryOf(raw: Record<string, unknown>, line: number, errors: EntryError[]): ListEntry | undefined {
  const ref = clean(raw.ref);
  const name = clean(raw.name);
  const tax = clean(raw.tax_code);
  const from = clean(raw.valid_from);
  const until = clean(raw.valid_until);
  const fail = (problem: EntryProblem): undefined => {
    errors.push({ line, problem });
    return undefined;
  };
  if (ref === '') return fail('REF');
  if (ref.length > 200 || name.length > 300 || tax.length > 40) return fail('LENGTH');
  if (name === '' && tax === '') return fail('IDENTITY');
  if ((from !== '' && !DAY.test(from)) || (until !== '' && !DAY.test(until))) return fail('DAY');
  if (from !== '' && until !== '' && until < from) return fail('PERIOD');
  return { ref, ...(name === '' ? {} : { name }), ...(tax === '' ? {} : { tax_code: tax }), ...(from === '' ? {} : { valid_from: from }), ...(until === '' ? {} : { valid_until: until }) };
}

const HEADER_CELLS = new Set(['ref', 'name', 'tax_code', 'valid_from', 'valid_until']);

/** The first line is a header when it is made of the column names and nothing else (a reference that merely starts with "ref" is data). */
function isHeaderLine(line: string): boolean {
  const cells = splitCells(line).map((cell) => cell.toLowerCase());
  return cells[0] === 'ref' && cells.every((cell) => HEADER_CELLS.has(cell));
}

/** The cells of a line separated by a comma, a semicolon or a tab; a cell in double quotes keeps the separators inside it (two quotes in a row are one quote). */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quoted) {
      if (char === '"' && line.charAt(index + 1) === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"' && current.trim() === '') {
      quoted = true;
      current = '';
    } else if (char === ',' || char === ';' || char === '\t') {
      cells.push(current.trim());
      current = '';
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * The entries of a pasted list: a JSON array of objects, or lines of text with the columns ref, name, tax code, valid from, valid until (separated by a comma, a semicolon or a tab, a cell in double quotes may hold them; a first line made of the column names is the header).
 * Every line is judged on its own and a bad line is named, so that nothing is sent that the server would refuse and nothing is dropped without being said. The server judges again.
 */
export function parseEntries(source: string): ParsedEntries {
  const text = source.trim();
  const errors: EntryError[] = [];
  const entries: ListEntry[] = [];
  if (text === '') return { entries, errors: [{ line: 1, problem: 'EMPTY' }] };
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { entries, errors: [{ line: 1, problem: 'JSON' }] };
    }
    if (!Array.isArray(parsed)) return { entries, errors: [{ line: 1, problem: 'JSON' }] };
    if (parsed.length > MAX_ENTRIES) return { entries, errors: [{ line: 1, problem: 'TOO_MANY' }] };
    parsed.forEach((item, index) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        errors.push({ line: index + 1, problem: 'JSON' });
        return;
      }
      const entry = entryOf(item as Record<string, unknown>, index + 1, errors);
      if (entry !== undefined) entries.push(entry);
    });
    return { entries, errors };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const body = isHeaderLine(lines[0] ?? '') ? lines.slice(1) : lines;
  if (body.length > MAX_ENTRIES) return { entries, errors: [{ line: 1, problem: 'TOO_MANY' }] };
  const offset = body.length === lines.length ? 1 : 2;
  body.forEach((line, index) => {
    const cells = splitCells(line);
    const entry = entryOf({ ref: cells[0], name: cells[1], tax_code: cells[2], valid_from: cells[3], valid_until: cells[4] }, index + offset, errors);
    if (entry !== undefined) entries.push(entry);
  });
  if (entries.length === 0 && errors.length === 0) errors.push({ line: 1, problem: 'EMPTY' });
  return { entries, errors };
}

// ---- disputes and the export --------------------------------------------------------------------------------------------------------------------------------------------------

export const ocdsFileName = (asOf: string): string => `ocds-parties-${vietnamDay(asOf) || 'export'}.json`;

/** The text of the file the export downloads: the OCDS block of parties, readable, two spaces. */
export const ocdsFileText = (answer: OcdsExport): string => JSON.stringify({ parties: answer.parties }, null, 2);
