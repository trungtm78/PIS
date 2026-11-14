import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { formProblemText } from '../labels';
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

/** What the task asks for before it can be completed: the checklist, the legal document types, the forms of the template, and the evidence that was attached. */
export function RequirementsSection({ task, canWork, onTick, onResult }: RequirementsProps) {
  const { t } = useTranslation();
  const evidenceColumns: DataTableColumn<EvidenceRow>[] = [
    { key: 'kind', header: t('pwf.task.evidence.col.kind'), render: (row) => row.evidence_kind },
    { key: 'item', header: t('pwf.task.evidence.col.item'), render: (row) => row.item_code ?? '–' },
    { key: 'what', header: t('pwf.task.evidence.col.what'), render: (row) => row.document_title ?? row.legal_doc_type ?? row.form_template_code ?? row.document_id ?? row.external_ref ?? '–' },
    { key: 'note', header: t('pwf.task.evidence.col.note'), render: (row) => row.note ?? '–' },
    { key: 'at', header: t('pwf.task.evidence.col.at'), render: (row) => stampText(row.attached_at) },
  ];
  return (
    <>
      <SectionCard title={t('pwf.task.checklist.title')}>
        {task.checklist.length === 0 ? (
          <p className="callout" role="status" data-testid="checklist-empty">
            {t('pwf.task.checklist.empty')}
          </p>
        ) : (
          <ul className="pwf-list" data-testid="checklist">
            {task.checklist.map((item) => (
              <li key={item.item_code} data-item={item.item_code}>
                <strong>{item.name}</strong> <code>{item.item_code}</code> {item.required ? t('pwf.task.required.yes') : t('pwf.task.required.no')}{' '}
                {item.done ? (
                  <StatusPill tone="success" icon="✓">
                    {t('pwf.task.checklist.done', { at: stampText(item.done_at) })}
                  </StatusPill>
                ) : (
                  <>
                    <StatusPill tone="warning" icon="⚠">
                      {t('pwf.task.checklist.open')}
                    </StatusPill>
                    {canWork ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`tick-${item.item_code}`} onClick={() => onTick(item.item_code, item.name)}>
                        {t('pwf.task.checklist.tick.action')}
                      </button>
                    ) : null}
                  </>
                )}
                {item.evidence_kinds.length === 0 ? null : <span className="pwf-hint"> {t('pwf.task.checklist.kinds', { kinds: item.evidence_kinds.join(', ') })}</span>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={t('pwf.task.documents.title')}>
        <div data-testid="documents">
          {task.legal_doc_types.length === 0 && task.form_templates.length === 0 ? (
            <p className="callout" role="status">
              {t('pwf.task.documents.empty')}
            </p>
          ) : (
            <ul className="pwf-list">
              {task.legal_doc_types.map((item) => (
                <li key={`legal:${item.code}`} data-legal={item.code}>
                  {t('pwf.task.documents.legal', { code: item.code })} <Satisfied satisfied={item.satisfied} />
                </li>
              ))}
              {task.form_templates.map((item) => (
                <li key={`form:${item.code}`} data-form={item.code}>
                  {t('pwf.task.documents.form', { code: item.code })} <Satisfied satisfied={item.satisfied} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>
      <SectionCard title={t('pwf.task.evidence.title')}>
        <div data-testid="evidence">
          {task.evidence.length === 0 ? (
            <p className="callout" role="status" data-testid="evidence-empty">
              {t('pwf.task.evidence.empty')}
            </p>
          ) : (
            <DataTable columns={evidenceColumns} rows={task.evidence} rowKey={(row) => row.id} caption={t('pwf.task.evidence.caption')} />
          )}
          {canWork ? <EvidenceAttachForm task={task} onResult={onResult} /> : null}
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
      <h3>{t('pwf.task.attach.title')}</h3>
      <div className="pwf-filters">
        <Field id="evidence-kind" label={t('pwf.task.attach.kind.label')} error={error('evidenceKind')} testKey="kind">
          <input id="evidence-kind" list="evidence-kinds" data-testid="field-kind" value={form.evidenceKind} onChange={(event) => change({ evidenceKind: event.target.value })} {...problemAttributes('evidence-kind', error('evidenceKind'))} />
          <datalist id="evidence-kinds">
            {kinds.map((kind) => (
              <option key={kind} value={kind} />
            ))}
          </datalist>
        </Field>
        <Field id="evidence-item" label={t('pwf.task.attach.item.label')} error={undefined} testKey="item">
          <select id="evidence-item" data-testid="field-item" value={form.itemCode} onChange={(event) => change({ itemCode: event.target.value })}>
            <option value="">{t('pwf.task.attach.item.none')}</option>
            {task.checklist.map((item) => (
              <option key={item.item_code} value={item.item_code}>
                {item.item_code} · {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="evidence-legal" label={t('pwf.task.attach.legal.label')} error={undefined} testKey="legal">
          <select id="evidence-legal" data-testid="field-legal" value={form.legalDocType} onChange={(event) => change({ legalDocType: event.target.value })}>
            <option value="">{t('pwf.task.attach.legal.none')}</option>
            {task.legal_doc_types.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code}
              </option>
            ))}
          </select>
        </Field>
        <Field id="evidence-form" label={t('pwf.task.attach.form.label')} error={undefined} testKey="form">
          <select id="evidence-form" data-testid="field-form" value={form.formTemplateCode} onChange={(event) => change({ formTemplateCode: event.target.value })}>
            <option value="">{t('pwf.task.attach.form.none')}</option>
            {task.form_templates.map((item) => (
              <option key={item.code} value={item.code}>
                {item.code}
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
