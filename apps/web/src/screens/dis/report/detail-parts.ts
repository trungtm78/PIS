/** What a report carries beyond its six cells (ST-DIS-004): the volumes, the notes, the files and the review of DIS-06, as the server answers them. */
type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9]{1,24}$/.test(value) ? value : undefined);

/** The volumes of DIS-03: what was built, accepted, sent to the Treasury and is being prepared, as of the last day of the period. */
export interface Progress {
  constructionVnd: string;
  acceptanceVnd: string;
  treasurySubmittedVnd: string;
  preparingDossierVnd: string;
  physicalProgressPct: string | null;
  asOfDate: string;
}

export function toProgress(raw: unknown): Progress | null {
  const row = asRecord(raw);
  const construction = dong(row?.construction_vnd);
  const acceptance = dong(row?.acceptance_vnd);
  const treasury = dong(row?.treasury_submitted_vnd);
  const preparing = dong(row?.preparing_dossier_vnd);
  const asOf = text(row?.as_of_date);
  if (row === undefined || construction === undefined || acceptance === undefined || treasury === undefined || preparing === undefined || asOf === undefined) return null;
  return { constructionVnd: construction, acceptanceVnd: acceptance, treasurySubmittedVnd: treasury, preparingDossierVnd: preparing, physicalProgressPct: nullableText(row.physical_progress_pct), asOfDate: asOf };
}

/** The words of DIS-06: each section is optional in the weekly report. The issues the notes speak about are kept as they were named. */
export interface Narrative {
  results: string | null;
  causes: string | null;
  solutions: string | null;
  proposals: string | null;
  linkedIssueIds: string[];
}

export function toNarrative(raw: unknown): Narrative | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  return {
    results: nullableText(row.results),
    causes: nullableText(row.causes),
    solutions: nullableText(row.solutions),
    proposals: nullableText(row.proposals),
    linkedIssueIds: (Array.isArray(row.linked_issue_ids) ? row.linked_issue_ids : []).filter((id): id is string => typeof id === 'string'),
  };
}

/** A file attached to a report, as the upload door answered it and the draft kept it. */
export interface Attachment {
  fileObjectId: string;
  fileSha256: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export function toAttachment(raw: unknown): Attachment | undefined {
  const row = asRecord(raw);
  const id = text(row?.file_object_id);
  const sha = text(row?.file_sha256);
  const name = text(row?.file_name);
  const size = row?.size_bytes;
  if (row === undefined || id === undefined || sha === undefined || name === undefined || typeof size !== 'number') return undefined;
  return { fileObjectId: id, fileSha256: sha, fileName: name, contentType: text(row.content_type) ?? '', sizeBytes: size };
}

/** One thing the review found: its code, the place on the report it is about and the figures it is made of. */
export interface Finding {
  code: string;
  field: string;
  values: Record<string, string | null>;
}

/** The review of a draft before it is sent (BR-DIS-07): an error stops the sending, a warning does not. */
export interface Review {
  blocking: boolean;
  errors: Finding[];
  warnings: Finding[];
}

function toFinding(raw: unknown): Finding | undefined {
  const row = asRecord(raw);
  const code = text(row?.code);
  const field = text(row?.field);
  if (row === undefined || code === undefined || field === undefined) return undefined;
  const values: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(asRecord(row.values) ?? {})) values[key] = typeof value === 'string' ? value : null;
  return { code, field, values };
}

export function toReview(raw: unknown): Review | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const list = (value: unknown): Finding[] => (Array.isArray(value) ? value : []).flatMap((entry) => toFinding(entry) ?? []);
  return { blocking: row.blocking === true, errors: list(row.errors), warnings: list(row.warnings) };
}
