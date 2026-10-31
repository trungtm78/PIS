/** The comparison of two revisions of a template (DOC-15, ST-DOC-016, UAT-AC423): the content, the schema of the placeholders, the legal basis and the people behind each. */

export const COMPARE_PERMISSION = 'doc.template.read';

export interface Block {
  kind: string;
  text: string;
}

export interface RevisionRef {
  id: string;
  revision: number;
  status: string;
}

export interface RevisionDetail {
  id: string;
  templateCode: string;
  revision: number;
  title: string;
  status: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  legalBasis: string;
  legalConfirmationRef: string | null;
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  watermarkText: string | null;
  blocks: Block[];
  required: string[];
  createdByName: string | null;
  approvedByName: string | null;
  legalConfirmedByName: string | null;
  revisions: RevisionRef[];
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function toRevisionDetail(raw: unknown): RevisionDetail {
  const row: Raw = isRecord(raw) ? raw : {};
  const body: Raw = isRecord(row.body_blocks) ? row.body_blocks : {};
  const schema: Raw = isRecord(row.placeholder_schema) ? row.placeholder_schema : {};
  return {
    id: text(row.id),
    templateCode: text(row.template_code),
    revision: count(row.revision),
    title: text(row.title),
    status: text(row.status),
    effectiveFrom: text(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    legalBasis: text(row.legal_basis),
    legalConfirmationRef: nullableText(row.legal_confirmation_ref),
    confirmationStatus: row.confirmation_status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
    watermarkText: nullableText(row.watermark_text),
    blocks: (Array.isArray(body.blocks) ? body.blocks : []).flatMap((entry): Block[] => (isRecord(entry) ? [{ kind: text(entry.kind), text: text(entry.text) }] : [])),
    required: (Array.isArray(schema.required) ? schema.required : []).filter((item): item is string => typeof item === 'string'),
    createdByName: nullableText(row.created_by_name),
    approvedByName: nullableText(row.approved_by_name),
    legalConfirmedByName: nullableText(row.legal_confirmed_by_name),
    revisions: (Array.isArray(row.revisions) ? row.revisions : []).flatMap((entry): RevisionRef[] => (isRecord(entry) ? [{ id: text(entry.id), revision: count(entry.revision), status: text(entry.status) }] : [])),
  };
}

export const blockLines = (blocks: readonly Block[]): string[] => blocks.map((block) => `${block.kind}: ${block.text}`);

export interface DiffLine {
  change: 'same' | 'removed' | 'added';
  text: string;
}

/** The lines of the two contents side by side as a list of kept, removed and added lines: the longest common run is kept, in order (a line moved is one removed and one added). */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const common: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i]![j] = before[i] === after[j] ? (common[i + 1]![j + 1] ?? 0) + 1 : Math.max(common[i + 1]![j] ?? 0, common[i]![j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push({ change: 'same', text: before[i] as string });
      i += 1;
      j += 1;
    } else if (j >= after.length || (i < before.length && (common[i + 1]![j] ?? 0) >= (common[i]![j + 1] ?? 0))) {
      lines.push({ change: 'removed', text: before[i] as string });
      i += 1;
    } else {
      lines.push({ change: 'added', text: after[j] as string });
      j += 1;
    }
  }
  return lines;
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  kept: string[];
}

/** The placeholders a revision requires, against the revision before: those it adds, those it drops and those that stay. */
export function diffRequired(before: readonly string[], after: readonly string[]): SchemaDiff {
  return {
    added: after.filter((name) => !before.includes(name)),
    removed: before.filter((name) => !after.includes(name)),
    kept: after.filter((name) => before.includes(name)),
  };
}

/** The revision to compare a revision with when none is named: the one before it, else the one after it. */
export function defaultOther(revisions: readonly RevisionRef[], id: string): string | undefined {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  const at = ordered.findIndex((entry) => entry.id === id);
  if (at < 0) return undefined;
  return (ordered[at - 1] ?? ordered[at + 1])?.id;
}
