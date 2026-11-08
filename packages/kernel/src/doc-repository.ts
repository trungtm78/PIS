import { sha256Hex } from './canonical-json.ts';
import { hasControlChar, hasControlCharExceptWhitespace } from './control-chars.ts';
import { DomainError } from './errors.ts';

/**
 * The project document repository (DOC-2, requirements PD.01 and PD.02 of the customer dossier): the files a project keeps (decisions, designs, estimates, tender files, contracts, acceptance and
 * payment records, reports), each with a class, an effective period and links to the project, the contract and the package it belongs to. A document has versions; a version is a PDF, a Word file or a
 * workbook whose text is read into units that can be cited exactly (page and paragraph, or sheet and cell). An approved version is locked: it never changes, and the next change is a new version.
 *
 * Everything here is pure: the store, the controllers and the screens only apply it.
 */

export const REPOSITORY_FORMATS = ['PDF', 'DOCX', 'XLSX'] as const;
export type RepositoryFormat = (typeof REPOSITORY_FORMATS)[number];

const OOXML = 'application/vnd.openxmlformats-officedocument.';
export const FORMAT_MIME: Readonly<Record<RepositoryFormat, string>> = {
  PDF: 'application/pdf',
  DOCX: `${OOXML}wordprocessingml.document`,
  XLSX: `${OOXML}spreadsheetml.sheet`,
};

/** The format a declared (or detected) content type stands for; undefined for anything the repository does not keep. */
export function repositoryFormatOf(contentType: string): RepositoryFormat | undefined {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return REPOSITORY_FORMATS.find((format) => FORMAT_MIME[format] === type);
}

/**
 * The classes of a project document. The column keeps any code of this shape, so a class is added here, in one place, without a migration; the kernel is the register of the classes a tenant may use.
 */
export const DOCUMENT_CLASSES = [
  'LEGAL_BASIS',
  'INVESTMENT_DECISION',
  'FEASIBILITY',
  'DESIGN',
  'COST_ESTIMATE',
  'PROCUREMENT',
  'CONTRACT',
  'ACCEPTANCE',
  'PAYMENT',
  'SETTLEMENT',
  'REPORT',
  'CORRESPONDENCE',
  'OTHER',
] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];
export const DOCUMENT_CLASS_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The security classes of a file, as the DOC engine keeps them on its own documents. */
export const SECURITY_CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL'] as const;
export type SecurityClass = (typeof SECURITY_CLASSES)[number];

export const MAX_TITLE_LENGTH = 300;
export const MAX_REFERENCE_LENGTH = 120;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_COMMENT_LENGTH = 4000;
export const MAX_UNITS_PER_VERSION = 50_000;
export const MAX_UNIT_TEXT_LENGTH = 20_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

function plainText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.normalize('NFC').trim();
  if (text.length < min || text.length > max || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

/** A calendar date as `YYYY-MM-DD` that exists (2026-02-30 does not). */
export function calendarDateOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw invalid(field);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

export interface ProjectDocumentInput {
  projectId: string;
  contractId: string | null;
  packageId: string | null;
  docClass: string;
  title: string;
  reference: string | null;
  securityClass: SecurityClass;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
}

const optionalText = (value: unknown, field: string, max: number): string | null => (value === undefined || value === null || value === '' ? null : plainText(value, field, 1, max));

/** The class of a document: one of the registered classes (422 VALIDATION_FAILED on `doc_class` otherwise). */
export function documentClassOf(value: unknown): string {
  if (typeof value !== 'string' || !DOCUMENT_CLASS_PATTERN.test(value) || !(DOCUMENT_CLASSES as readonly string[]).includes(value)) throw invalid('doc_class');
  return value;
}

/** The effective period must close after it opens, and both ends are calendar dates (422 on `effective_to`). */
export function effectivePeriodOf(from: unknown, to: unknown): { effectiveFrom: string | null; effectiveTo: string | null } {
  const effectiveFrom = from === undefined || from === null ? null : calendarDateOf(from, 'effective_from');
  const effectiveTo = to === undefined || to === null ? null : calendarDateOf(to, 'effective_to');
  if (effectiveFrom !== null && effectiveTo !== null && effectiveTo < effectiveFrom) throw invalid('effective_to', 'BEFORE_EFFECTIVE_FROM');
  return { effectiveFrom, effectiveTo };
}

export type EffectiveState = 'UNDATED' | 'NOT_YET' | 'IN_FORCE' | 'EXPIRED';

/** Where a document stands on a day (the day in Vietnam, as `YYYY-MM-DD`): the period is closed at both ends. A document with no dates is `UNDATED`, never assumed in force. */
export function effectiveStateOn(period: { effectiveFrom: string | null; effectiveTo: string | null }, today: string): EffectiveState {
  if (period.effectiveFrom === null && period.effectiveTo === null) return 'UNDATED';
  if (period.effectiveFrom !== null && today < period.effectiveFrom) return 'NOT_YET';
  if (period.effectiveTo !== null && today > period.effectiveTo) return 'EXPIRED';
  return 'IN_FORCE';
}

/** What a caller sends to create a document, checked and normalised (links are checked against the database by the store: the contract and the package must belong to the project). */
export function projectDocumentInputOf(raw: Record<string, unknown>): ProjectDocumentInput {
  const projectId = typeof raw.project_id === 'string' ? raw.project_id.toLowerCase() : '';
  if (!UUID.test(projectId)) throw invalid('project_id');
  const link = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) throw invalid(field);
    return value.toLowerCase();
  };
  const securityClass = raw.security_class === undefined ? 'INTERNAL' : SECURITY_CLASSES.find((candidate) => candidate === raw.security_class);
  if (securityClass === undefined) throw invalid('security_class');
  return {
    projectId,
    contractId: link(raw.contract_id, 'contract_id'),
    packageId: link(raw.package_id, 'package_id'),
    docClass: documentClassOf(raw.doc_class),
    title: plainText(raw.title, 'title', 3, MAX_TITLE_LENGTH),
    reference: optionalText(raw.reference, 'reference', MAX_REFERENCE_LENGTH),
    securityClass,
    ...effectivePeriodOf(raw.effective_from, raw.effective_to),
    note: optionalText(raw.note, 'note', MAX_NOTE_LENGTH),
  };
}

/** A change to the description of a document: only the members that are present change. The project never changes; the links may, inside the same project. */
export interface ProjectDocumentChange {
  contractId?: string | null;
  packageId?: string | null;
  docClass?: string;
  title?: string;
  reference?: string | null;
  securityClass?: SecurityClass;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  note?: string | null;
}

export function projectDocumentChangeOf(raw: Record<string, unknown>, current: { effectiveFrom: string | null; effectiveTo: string | null }): ProjectDocumentChange {
  const change: ProjectDocumentChange = {};
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);
  if (has('project_id')) throw invalid('project_id', 'PROJECT_IS_FIXED');
  if (has('contract_id')) change.contractId = raw.contract_id === null ? null : (typeof raw.contract_id === 'string' && UUID.test(raw.contract_id.toLowerCase()) ? raw.contract_id.toLowerCase() : fail('contract_id'));
  if (has('package_id')) change.packageId = raw.package_id === null ? null : (typeof raw.package_id === 'string' && UUID.test(raw.package_id.toLowerCase()) ? raw.package_id.toLowerCase() : fail('package_id'));
  if (has('doc_class')) change.docClass = documentClassOf(raw.doc_class);
  if (has('title')) change.title = plainText(raw.title, 'title', 3, MAX_TITLE_LENGTH);
  if (has('reference')) change.reference = optionalText(raw.reference, 'reference', MAX_REFERENCE_LENGTH);
  if (has('security_class')) {
    const securityClass = SECURITY_CLASSES.find((candidate) => candidate === raw.security_class);
    if (securityClass === undefined) throw invalid('security_class');
    change.securityClass = securityClass;
  }
  if (has('effective_from') || has('effective_to')) {
    const period = effectivePeriodOf(has('effective_from') ? raw.effective_from : current.effectiveFrom, has('effective_to') ? raw.effective_to : current.effectiveTo);
    if (has('effective_from')) change.effectiveFrom = period.effectiveFrom;
    if (has('effective_to')) change.effectiveTo = period.effectiveTo;
  }
  if (has('note')) change.note = optionalText(raw.note, 'note', MAX_NOTE_LENGTH);
  if (Object.keys(change).length === 0) throw invalid('body', 'EMPTY_CHANGE');
  return change;
}

function fail(field: string): never {
  throw invalid(field);
}

// ---- versions: the states and the lock (PD.02) -------------------------------------------------------------------------------------------------------

export const VERSION_STATUSES = ['DRAFT', 'IN_REVIEW', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'APPROVED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * Where a version may go. A draft goes to review; a review ends in approval, a request for a supplement or a rejection (or is withdrawn, back to draft). A version that was sent back or rejected stays as it was: the
 * supplement is a new version. An approved version is the end: it is locked.
 */
const VERSION_MOVES: Readonly<Record<VersionStatus, readonly VersionStatus[]>> = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'DRAFT'],
  SUPPLEMENT_REQUESTED: [],
  REJECTED: [],
  APPROVED: [],
};

export const nextVersionStatuses = (from: VersionStatus): readonly VersionStatus[] => VERSION_MOVES[from];

/** 409 DOC_VERSION_STATE_INVALID when the move is not on the table. */
export function assertVersionMove(from: VersionStatus, to: VersionStatus): void {
  if (!VERSION_MOVES[from].includes(to)) throw new DomainError('DOC_VERSION_STATE_INVALID', 409, 'status', { extensions: { from, to } });
}

/** The lock of an approved version: what the version says and what it is made of never change again (409 DOC_VERSION_LOCKED). */
export function isVersionLocked(status: VersionStatus): boolean {
  return status === 'APPROVED';
}

export function assertVersionNotLocked(status: VersionStatus): void {
  if (isVersionLocked(status)) throw new DomainError('DOC_VERSION_LOCKED', 409, 'status');
}

/** Only a draft is sent to review. */
export function assertSubmittable(status: VersionStatus): void {
  if (status !== 'DRAFT') throw new DomainError('DOC_VERSION_STATE_INVALID', 409, 'status', { extensions: { from: status, to: 'IN_REVIEW' } });
}

// ---- extraction: units and citations (the OCR contract) ----------------------------------------------------------------------------------------------

export const UNIT_KINDS = ['HEADING', 'PARAGRAPH', 'LIST_ITEM', 'TABLE_CELL', 'SHEET_CELL'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Where a unit sits in its file: a page and a paragraph of that page, a paragraph of the body, a cell of a table of a document, or a cell of a sheet. */
export interface UnitLocator {
  page?: number | undefined;
  paragraph?: number | undefined;
  table?: number | undefined;
  row?: number | undefined;
  column?: number | undefined;
  sheet?: string | undefined;
  cell?: string | undefined;
}

/** The box of a unit on its page, as fractions of the page (0 to 1) from the top left corner. */
export interface UnitBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One piece of text an extractor read. The sequence number, the citation and the digest are given by `normaliseExtraction`. */
export interface ExtractedUnit {
  kind: UnitKind;
  locator: UnitLocator;
  text: string;
  box?: UnitBox | undefined;
  /** How sure an OCR engine is, as a decimal from 0 to 1; a text layer or a structured file has no doubt and leaves it out. */
  confidence?: string | undefined;
}

export interface TextUnit {
  seq: number;
  citationId: string;
  kind: UnitKind;
  locatorKey: string;
  label: string;
  page: number | null;
  paragraph: number | null;
  sheet: string | null;
  cell: string | null;
  box: UnitBox | null;
  text: string;
  textSha256: string;
  confidence: string | null;
}

const SHEET_NAME = /^[^\\/?*[\]:]{1,31}$/;
const validSheetName = (name: string): boolean => SHEET_NAME.test(name) && !hasControlChar(name);
const CELL_REF = /^[A-Z]{1,3}[1-9]\d{0,6}$/;

const whole = (value: number | undefined): boolean => value === undefined || (Number.isInteger(value) && value >= 1 && value <= 1_000_000);

/**
 * The key of a locator, the text a citation is derived from. It is stable for a place in a file: `p3/para2` (page 3, paragraph 2 of the page), `para12` (paragraph 12 of the body), `t2/r3c4` (table 2, row 3, column 4),
 * `Budget!B7` (a cell). A locator that names nothing, or a place twice over, is refused (422).
 */
export function locatorKeyOf(locator: UnitLocator): string {
  if (!whole(locator.page) || !whole(locator.paragraph) || !whole(locator.table) || !whole(locator.row) || !whole(locator.column)) throw invalid('locator');
  if (locator.sheet !== undefined || locator.cell !== undefined) {
    if (locator.sheet === undefined || locator.cell === undefined || !validSheetName(locator.sheet) || !CELL_REF.test(locator.cell)) throw invalid('locator');
    return `${locator.sheet}!${locator.cell}`;
  }
  if (locator.table !== undefined) {
    if (locator.row === undefined || locator.column === undefined) throw invalid('locator');
    return `${locator.page === undefined ? '' : `p${locator.page}/`}t${locator.table}/r${locator.row}c${locator.column}`;
  }
  if (locator.paragraph === undefined) throw invalid('locator');
  return `${locator.page === undefined ? '' : `p${locator.page}/`}para${locator.paragraph}`;
}

/**
 * The stable id of a citation: the same file read twice gives the same ids, so a citation made today still points at the same text after a re-extraction, and the same file kept in two versions or two documents
 * is cited the same way. It is the digest of the file and the place, never of the text, so correcting a reading does not move a citation.
 */
export function citationIdOf(fileSha256: string, locatorKey: string): string {
  return `cit_${sha256Hex(`${fileSha256}\n${locatorKey}`).slice(0, 20)}`;
}

export const CITATION_ID = /^cit_[0-9a-f]{20}$/;

/** What another feature stores to cite a place of a version: `docver:<version id>#<citation id>`. */
export function citationRefOf(versionId: string, citationId: string): string {
  return `docver:${versionId}#${citationId}`;
}

export function parseCitationRef(ref: string): { versionId: string; citationId: string } | undefined {
  const match = /^docver:([0-9a-f-]{36})#(cit_[0-9a-f]{20})$/.exec(ref);
  if (match === null || !UUID.test(match[1] ?? '')) return undefined;
  return { versionId: match[1] as string, citationId: match[2] as string };
}

/** A short label of a place for a person who reads a citation: `p. 3, paragraph 2`, `sheet Budget, cell B7`. Words come from the screens' own texts; this is the neutral form. */
export function locatorLabelOf(locator: UnitLocator): string {
  if (locator.sheet !== undefined && locator.cell !== undefined) return `${locator.sheet}!${locator.cell}`;
  const parts: string[] = [];
  if (locator.page !== undefined) parts.push(`p${locator.page}`);
  if (locator.table !== undefined) parts.push(`t${locator.table} r${locator.row ?? 0} c${locator.column ?? 0}`);
  else if (locator.paragraph !== undefined) parts.push(`para${locator.paragraph}`);
  return parts.join(' ');
}

const CONFIDENCE = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/;

function boxOf(box: UnitBox | undefined): UnitBox | null {
  if (box === undefined) return null;
  const values = [box.x0, box.y0, box.x1, box.y1];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) || box.x1 < box.x0 || box.y1 < box.y0) throw invalid('box');
  return { x0: round6(box.x0), y0: round6(box.y0), x1: round6(box.x1), y1: round6(box.y1) };
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * What an extractor returned, made into the units the store keeps: in reading order, each with its stable citation. A unit with no text is dropped; the text is NFC and trimmed and cut at the longest a unit may be
 * (the cut is reported in `truncated`, never silent); two units at one place are refused (a defect of the extractor, 422 DOC_EXTRACTION_INVALID); more units than a version may hold are refused the same way.
 */
export function normaliseExtraction(fileSha256: string, extracted: readonly ExtractedUnit[]): { units: TextUnit[]; truncated: number } {
  const seen = new Set<string>();
  const units: TextUnit[] = [];
  let truncated = 0;
  for (const unit of extracted) {
    if (!(UNIT_KINDS as readonly string[]).includes(unit.kind)) throw new DomainError('DOC_EXTRACTION_INVALID', 422, 'kind');
    let text = unit.text.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    if (text.length > MAX_UNIT_TEXT_LENGTH) {
      text = text.slice(0, MAX_UNIT_TEXT_LENGTH);
      truncated += 1;
    }
    let key: string;
    try {
      key = locatorKeyOf(unit.locator);
    } catch {
      throw new DomainError('DOC_EXTRACTION_INVALID', 422, 'locator');
    }
    if (seen.has(key)) throw new DomainError('DOC_EXTRACTION_INVALID', 422, 'locator', { extensions: { reason: 'DUPLICATE_PLACE' } });
    seen.add(key);
    if (unit.confidence !== undefined && !CONFIDENCE.test(unit.confidence)) throw new DomainError('DOC_EXTRACTION_INVALID', 422, 'confidence');
    if (units.length >= MAX_UNITS_PER_VERSION) throw new DomainError('DOC_EXTRACTION_INVALID', 422, 'units', { extensions: { reason: 'TOO_MANY_UNITS' } });
    let box: UnitBox | null;
    try {
      box = boxOf(unit.box);
    } catch {
      throw new DomainError('DOC_EXTRACTION_INVALID', 422, 'box');
    }
    units.push({
      seq: units.length + 1,
      citationId: citationIdOf(fileSha256, key),
      kind: unit.kind,
      locatorKey: key,
      label: locatorLabelOf(unit.locator),
      page: unit.locator.page ?? null,
      paragraph: unit.locator.paragraph ?? null,
      sheet: unit.locator.sheet ?? null,
      cell: unit.locator.cell ?? null,
      box,
      text,
      textSha256: sha256Hex(text),
      confidence: unit.confidence ?? null,
    });
  }
  return { units, truncated };
}

export type ExtractionStatus = 'PENDING' | 'EXTRACTED' | 'NO_TEXT' | 'FAILED';

/** What the extraction left: a file with no text at all (a scan with no OCR engine bound) is `NO_TEXT`, which a screen words as "needs OCR", never as an empty document. */
export function extractionStatusOf(unitCount: number, failed: boolean): Exclude<ExtractionStatus, 'PENDING'> {
  if (failed) return 'FAILED';
  return unitCount === 0 ? 'NO_TEXT' : 'EXTRACTED';
}

// ---- comments ------------------------------------------------------------------------------------------------------------------------------------

export interface CommentInput {
  versionId: string;
  citationId: string | null;
  parentId: string | null;
  body: string;
}

/** A comment on a version: optionally anchored to a citation of that version, optionally a reply to another comment. */
export function commentInputOf(raw: Record<string, unknown>): CommentInput {
  const versionId = typeof raw.version_id === 'string' ? raw.version_id.toLowerCase() : '';
  if (!UUID.test(versionId)) throw invalid('version_id');
  let citationId: string | null = null;
  if (raw.citation_id !== undefined && raw.citation_id !== null) {
    if (typeof raw.citation_id !== 'string' || !CITATION_ID.test(raw.citation_id)) throw invalid('citation_id');
    citationId = raw.citation_id;
  }
  let parentId: string | null = null;
  if (raw.parent_id !== undefined && raw.parent_id !== null) {
    if (typeof raw.parent_id !== 'string' || !UUID.test(raw.parent_id.toLowerCase())) throw invalid('parent_id');
    parentId = raw.parent_id.toLowerCase();
  }
  return { versionId, citationId, parentId, body: plainText(raw.body, 'body', 2, MAX_COMMENT_LENGTH) };
}
