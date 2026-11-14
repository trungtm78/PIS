import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Named, docTypeKnown, docTypeName, evidenceKindName } from '../codes';
import { Meter } from '../components';
import { formProblemText } from '../labels';
import { FormRevision } from '../process/TaskProcessSection';
import { stampText } from '../model';
import type { TaskDetail } from '../model';
import { Field, problemAttributes } from './Field';
import { useAttachEvidence } from './hooks';
import { EMPTY_EVIDENCE, evidenceBody, validateEvidence } from './model';
import type { EvidenceField, EvidenceForm, EvidenceRow } from './model';

export interface RequirementsProps {
  task: TaskDetail;
  /** Ticking an item and attaching evidence are the doer's work: shown only when the server says the caller can complete the task. */
  canWork: boolean;
  onTick: (itemCode: string, itemName: string) => void;
  /** Told how a command ended: the refusal, or nothing on success. */
  onResult: (error?: unknown) => void;
}

function Satisfied({ satisfied }: { satisfied: boolean }) {
  const { t } = useTranslation();
  return satisfied ? (
    <StatusPill tone="success" icon="✓">
      {t('pwf.task.satisfied.yes')}
    </StatusPill>
  ) : (
    <StatusPill tone="warning" icon="⚠">
      {t('pwf.task.satisfied.no')}
    </StatusPill>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** What a piece of evidence is, in words: the legal document or the form it answers, else the reference typed with it; a document of the store is said as such, with the start of its id as a note. */
function EvidenceWhat({ row, task }: { row: EvidenceRow; task: TaskDetail }) {
  const { t } = useTranslation();
  const form = row.form_template_code === null ? undefined : task.form_templates.find((item) => item.code === row.form_template_code);
  // The title the document store gives the attached document comes first: it is what the person filed.
  const stored = row.document_id !== null;
  const documentTitle = typeof row.document_title === 'string' && row.document_title !== '' ? row.document_title : null;
  const title = documentTitle ?? (row.legal_doc_type !== null ? docTypeName(t, row.legal_doc_type) : row.form_template_code !== null ? (form?.current_title ?? row.form_template_code) : null);
  const code = documentTitle !== null ? null : (row.legal_doc_type ?? row.form_template_code);
  const reference = row.external_ref !== null && !UUID.test(row.external_ref) ? row.external_ref : null;
  return (
    <span className="pwf-cellstack">
      {title === null ? null : <Named name={title} code={code} />}
      {reference === null ? null : <span>{reference}</span>}
      {documentTitle !== null && row.legal_doc_type !== null ? <span className="pwf-hint">{docTypeName(t, row.legal_doc_type)}</span> : null}
      {stored && documentTitle === null ? (
        <span className="pwf-hint" title={row.document_id ?? undefined}>
          {t('pwf6.task.evidence.stored')}
        </span>
      ) : null}
      {title === null && reference === null && !stored ? <span className="pwf-hint">{t('pwf6.task.evidence.unnamed')}</span> : null}
      {row.form_template_revision === null || row.form_template_revision === undefined ? null : <span className="pwf-hint">{t('pwf6.task.evidence.revision', { revision: row.form_template_revision })}</span>}
    </span>
  );
}

/**
 * What the task asks for before it can be completed, in the order a person works: the checklist (each item is ticked where it stands; a required item says so), then the documents: the legal document types and the forms with their
 * revisions, the evidence that was attached, and the form that attaches more (closed until asked for).
 */
export function RequirementsSection({ task, canWork, onTick, onResult }: RequirementsProps) {
  const { t } = useTranslation();
  const itemName = (code: string | null): string | null => (code === null ? null : (task.checklist.find((item) => item.item_code === code)?.name ?? code));
  const evidenceColumns: DataTableColumn<EvidenceRow>[] = [
    { key: 'what', header: t('pwf.task.evidence.col.what'), render: (row) => <EvidenceWhat row={row} task={task} /> },
    { key: 'kind', header: t('pwf.task.evidence.col.kind'), render: (row) => evidenceKindName(t, row.evidence_kind) },
    { key: 'item', header: t('pwf.task.evidence.col.item'), render: (row) => itemName(row.item_code) ?? '' },
    { key: 'note', header: t('pwf.task.evidence.col.note'), render: (row) => row.note ?? '' },
    {
      key: 'at',
      header: t('pwf.task.evidence.col.at'),
      render: (row) => (
        <span className="pwf-cellstack">
          <span>{stampText(row.attached_at)}</span>
          {typeof row.attached_by_name === 'string' && row.attached_by_name !== '' ? <span className="pwf-hint">{row.attached_by_name}</span> : null}
        </span>
      ),
    },
  ];
  const doneCount = task.checklist.filter((item) => item.done).length;
  const forms = task.form_templates;
  return (
    <>
      <SectionCard title={t('pwf.task.checklist.title')} status={task.checklist.length === 0 ? undefined : <Meter done={doneCount} total={task.checklist.length} label={t('pwf.task.checklist.title')} />}>
        {task.checklist.length === 0 ? (
          <p className="pwf-hint" role="status" data-testid="checklist-empty">
            {t('pwf.task.checklist.empty')}
          </p>
        ) : (
          <ul className="pwf-checklist" data-testid="checklist">
            {task.checklist.map((item) => (
              <li key={item.item_code} className="pwf-checklist__item" data-item={item.item_code} data-done={item.done}>
                <span className="pwf-checklist__box" aria-hidden="true">
                  {item.done ? '✓' : ''}
                </span>
                <span className="pwf-checklist__body">
                  <span className="pwf-checklist__name">
                    <strong>{item.name}</strong>
                    {item.required ? <span className="pwf-required">{t('pwf.task.required.yes')}</span> : <span className="pwf-hint">{t('pwf.task.required.no')}</span>}
                  </span>
                  {item.evidence_kinds.length === 0 ? null : <span className="pwf-hint">{t('pwf.task.checklist.kinds', { kinds: item.evidence_kinds.map((kind) => evidenceKindName(t, kind)).join(', ') })}</span>}
                </span>
                <span className="pwf-checklist__state">
                  {item.done ? (
                    <StatusPill tone="success" icon="✓">
                      {t('pwf.task.checklist.done', { at: stampText(item.done_at) })}
                      {typeof item.done_by_name === 'string' && item.done_by_name !== '' ? ` · ${item.done_by_name}` : ''}
                    </StatusPill>
                  ) : (
                    <>
                      <StatusPill tone="warning" icon="○">
                        {t('pwf.task.checklist.open')}
                      </StatusPill>
                      {canWork ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`tick-${item.item_code}`} onClick={() => onTick(item.item_code, item.name)}>
                          {t('pwf.task.checklist.tick.action')}
                        </button>
                      ) : null}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={t('pwf6.task.documents.title')}>
        <div data-testid="documents">
          {task.legal_doc_types.length === 0 && forms.length === 0 ? (
            <p className="pwf-hint" role="status">
              {t('pwf.task.documents.empty')}
            </p>
          ) : (
            <ul className="pwf-docs">
              {task.legal_doc_types.map((item) => (
                <li key={`legal:${item.code}`} className="pwf-docs__item" data-legal={item.code}>
                  <span className="pwf-docs__kind">{t('pwf6.task.documents.legal')}</span>
                  <Named name={item.name ?? docTypeName(t, item.code)} code={(item.name ?? null) !== null || docTypeKnown(item.code) ? item.code : undefined} />
                  <Satisfied satisfied={item.satisfied} />
                </li>
              ))}
              {forms.map((item) => (
                <li key={`form:${item.code}`} className="pwf-docs__item" data-form={item.code}>
                  <span className="pwf-docs__kind">{t('pwf6.task.documents.form')}</span>
                  <Named name={item.current_title ?? item.code} code={item.current_title === null || item.current_title === undefined ? undefined : item.code} />
                  <Satisfied satisfied={item.satisfied} />
                  <FormRevision form={item} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <h3 className="pwf-subtitle">{t('pwf6.task.evidence.title')}</h3>
        <div data-testid="evidence">
          {task.evidence.length === 0 ? (
            <p className="pwf-hint" role="status" data-testid="evidence-empty">
              {t('pwf.task.evidence.empty')}
            </p>
          ) : (
            <div className="pwf-free">
              <DataTable columns={evidenceColumns} rows={task.evidence} rowKey={(row) => row.id} caption={t('pwf.task.evidence.caption')} />
            </div>
          )}
          {canWork ? (
            <details className="pwf-inline-fold" data-testid="evidence-fold">
              <summary>{t('pwf.task.attach.title')}</summary>
              <EvidenceAttachForm task={task} onResult={onResult} />
            </details>
          ) : null}
        </div>
      </SectionCard>
    </>
  );
}

const ERROR_FIELDS: readonly EvidenceField[] = ['evidenceKind', 'documentId', 'externalRef'];

function EvidenceAttachForm({ task, onResult }: { task: TaskDetail; onResult: (error?: unknown) => void }) {
  const { t } = useTranslation();
  const attach = useAttachEvidence();
  const [form, setForm] = useState<EvidenceForm>(EMPTY_EVIDENCE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateEvidence(form);
  const error = (field: EvidenceField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemText(t, problem) : undefined;
  };
  const change = (patch: Partial<EvidenceForm>): void => setForm({ ...form, ...patch });
  const kinds = [...new Set(task.checklist.flatMap((item) => item.evidence_kinds))];
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (attach.isPending || ERROR_FIELDS.some((field) => problems[field] !== undefined)) return;
    attach.mutate(
      { taskId: task.id, body: evidenceBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_EVIDENCE);
          setSubmitted(false);
          onResult();
        },
        onError: onResult,
      },
    );
  };
  return (
    <form className="pwf-assign" onSubmit={submit} noValidate aria-label={t('pwf.task.attach.title')} data-testid="evidence-form">
      <div className="pwf-filters">
        <Field id="evidence-kind" label={t('pwf.task.attach.kind.label')} error={error('evidenceKind')} testKey="kind">
          <input id="evidence-kind" list="evidence-kinds" data-testid="field-kind" value={form.evidenceKind} onChange={(event) => change({ evidenceKind: event.target.value })} {...problemAttributes('evidence-kind', error('evidenceKind'))} />
          <datalist id="evidence-kinds">
            {kinds.map((kind) => (
              <option key={kind} value={kind} label={evidenceKindName(t, kind)} />
            ))}
          </datalist>
        </Field>
        <Field id="evidence-item" label={t('pwf.task.attach.item.label')} error={undefined} testKey="item">
          <select id="evidence-item" data-testid="field-item" value={form.itemCode} onChange={(event) => change({ itemCode: event.target.value })}>
            <option value="">{t('pwf.task.attach.item.none')}</option>
            {task.checklist.map((item) => (
              <option key={item.item_code} value={item.item_code}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="evidence-legal" label={t('pwf.task.attach.legal.label')} error={undefined} testKey="legal">
          <select id="evidence-legal" data-testid="field-legal" value={form.legalDocType} onChange={(event) => change({ legalDocType: event.target.value })}>
            <option value="">{t('pwf.task.attach.legal.none')}</option>
            {task.legal_doc_types.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name ?? docTypeName(t, item.code)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="evidence-form" label={t('pwf.task.attach.form.label')} error={undefined} testKey="form">
          <select id="evidence-form" data-testid="field-form" value={form.formTemplateCode} onChange={(event) => change({ formTemplateCode: event.target.value })}>
            <option value="">{t('pwf.task.attach.form.none')}</option>
            {task.form_templates.map((item) => (
              <option key={item.code} value={item.code}>
                {item.current_title ?? item.code}
              </option>
            ))}
          </select>
        </Field>
        <Field id="evidence-document" label={t('pwf.task.attach.document.label')} error={error('documentId')} testKey="document">
          <input id="evidence-document" data-testid="field-document" value={form.documentId} onChange={(event) => change({ documentId: event.target.value })} {...problemAttributes('evidence-document', error('documentId'))} />
        </Field>
        <Field id="evidence-ref" label={t('pwf.task.attach.ref.label')} error={error('externalRef')} testKey="ref">
          <input id="evidence-ref" data-testid="field-ref" value={form.externalRef} onChange={(event) => change({ externalRef: event.target.value })} {...problemAttributes('evidence-ref', error('externalRef'))} />
        </Field>
        <Field id="evidence-note" label={t('pwf.task.attach.note.label')} error={undefined} testKey="note" wide>
          <textarea id="evidence-note" rows={2} data-testid="field-note" value={form.note} onChange={(event) => change({ note: event.target.value })} />
        </Field>
      </div>
      <div className="pwf-actions">
        <button type="submit" className="ui-button ui-button--primary" data-testid="attach" disabled={attach.isPending}>
          {t('pwf.task.attach.action')}
        </button>
      </div>
    </form>
  );
}
