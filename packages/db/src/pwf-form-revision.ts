import { DomainError } from '@machvon/kernel';
import type { pwfWorkflow } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * Which revision of a form an evidence was made from (PWF-4, R46). A form (`document_template`) has revisions; a task uses the newest one that is published and in force on the day the form is used (`LATEST_APPROVED`), or the one
 * revision its template pins (`PINNED`). The evidence keeps the revision and the hash of its content, so the form a document was made from is found again after the form is revised, and the screen of the task can say that a newer
 * revision exists. A document that was itself generated from a form says which revision it was (its version row names the template): that is taken before anything is looked up.
 */

export interface FormRevision {
  revision: number;
  sha256: string;
}

export interface CurrentFormRevision extends FormRevision {
  title: string;
  effectiveFrom: string;
  confirmationStatus: string;
}

interface RevisionSql {
  template_code: string;
  revision: number;
  content_sha256: string;
  title: string;
  effective_from: string;
  confirmation_status: string;
}

const COLUMNS = `t.template_code, t.revision, t.content_sha256::text as content_sha256, t.title, t.effective_from::text as effective_from, t.confirmation_status`;
const current = (row: RevisionSql): CurrentFormRevision => ({ revision: row.revision, sha256: row.content_sha256.trim(), title: row.title, effectiveFrom: row.effective_from, confirmationStatus: row.confirmation_status });

/** The newest revision of each form that is published and in force on the day, by code; a form with none is absent. */
export async function currentFormRevisions(tx: TenantTx, codes: readonly string[], today: string): Promise<Map<string, CurrentFormRevision>> {
  if (codes.length === 0) return new Map();
  const rows = await tx.query<RevisionSql>(
    `select distinct on (t.template_code) ${COLUMNS}
       from machvon.document_template t
      where t.template_code = any($1::text[]) and t.status = 'PUBLISHED' and t.effective_from <= $2::date and (t.effective_until is null or t.effective_until > $2::date)
      order by t.template_code, t.revision desc`,
    [[...codes], today],
  );
  return new Map(rows.map((row) => [row.template_code, current(row)] as const));
}

/** Whether a form has this revision, approved at some time (published now or replaced since): what a pinned revision must be. */
export async function approvedFormRevision(tx: TenantTx, code: string, revision: number): Promise<FormRevision | undefined> {
  const rows = await tx.query<RevisionSql>(`select ${COLUMNS} from machvon.document_template t where t.template_code = $1 and t.revision = $2::int and t.status in ('PUBLISHED', 'SUPERSEDED')`, [code, revision]);
  return rows[0] === undefined ? undefined : { revision: rows[0].revision, sha256: rows[0].content_sha256.trim() };
}

/** What the NEWEST version of a document was generated from: the code and the revision of its form, or nothing when that version was not generated from a form (an uploaded file). An older version of the document never answers for the newest one. */
async function templateOfDocument(tx: TenantTx, documentId: string): Promise<(FormRevision & { code: string }) | undefined> {
  const rows = await tx.query<{ template_code: string | null; revision: number | null; content_sha256: string | null }>(
    `select t.template_code, t.revision, t.content_sha256::text as content_sha256
       from machvon.document_version dv left join machvon.document_template t on t.tenant_id = dv.tenant_id and t.id = dv.template_id
      where dv.document_id = $1::uuid
      order by dv.version desc limit 1`,
    [documentId],
  );
  const row = rows[0];
  return row === undefined || row.template_code === null || row.revision === null || row.content_sha256 === null ? undefined : { code: row.template_code, revision: row.revision, sha256: row.content_sha256.trim() };
}

/**
 * The revision an evidence of a form is recorded with. Under `PINNED` the revision must exist, and a document that says what it was generated from must have been generated from that form at that revision (422
 * `PWF_FORM_REVISION_UNAVAILABLE` otherwise: a pinned form is never silently another one). Under `LATEST_APPROVED` a document generated from the form says its revision itself; one generated from ANOTHER form is recorded without a
 * revision (no screen may show a revision the document was not made from); a file that was uploaded, or no document at all, takes the newest approved revision of the day, and a form that has no approved revision in the document
 * store of the tenant is recorded without one (as evidence always was before revisions were kept).
 */
export async function resolveFormRevision(tx: TenantTx, input: { code: string; policy: pwfWorkflow.TemplateFormPolicy; documentId: string | null; today: string }): Promise<FormRevision | null> {
  const source = input.documentId === null ? undefined : await templateOfDocument(tx, input.documentId);
  const made = source !== undefined && source.code === input.code ? { revision: source.revision, sha256: source.sha256 } : undefined;
  const otherForm = source !== undefined && source.code !== input.code;
  if (input.policy.policy === 'PINNED') {
    const pinned = input.policy.revision === null ? undefined : await approvedFormRevision(tx, input.code, input.policy.revision);
    if (pinned === undefined || otherForm || (made !== undefined && made.revision !== pinned.revision)) {
      throw new DomainError('PWF_FORM_REVISION_UNAVAILABLE', 422, 'form_template_code', { extensions: { form_template_code: input.code, pinned_revision: input.policy.revision, document_revision: made?.revision ?? null, document_form_code: source?.code ?? null } });
    }
    return pinned;
  }
  if (made !== undefined) return made;
  if (otherForm) return null;
  const latest = (await currentFormRevisions(tx, [input.code], input.today)).get(input.code);
  return latest === undefined ? null : { revision: latest.revision, sha256: latest.sha256 };
}
