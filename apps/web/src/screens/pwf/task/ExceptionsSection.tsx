import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { docTypeName } from '../codes';
import { exceptionWord, formProblemText } from '../labels';
import { MIN_REASON, dayText } from '../model';
import type { ExceptionKind, TaskDetail } from '../model';
import { Field, problemAttributes } from './Field';
import { useRequestException } from './hooks';
import { exceptionStatusWord } from './labels';
import { EMPTY_EXCEPTION, EXCEPTION_KINDS, exceptionBody, validateException } from './model';
import type { ExceptionField, ExceptionForm, TaskException } from './model';

export interface ExceptionsProps {
  task: TaskDetail;
  canRequest: boolean;
  canDecide: boolean;
  /** Items to put in a new waiver (the requirements the completion check says a waiver could cover); `seq` changes each time so the form starts over from them. */
  prefill: { items: string; seq: number } | undefined;
  onDecide: (exception: TaskException, decision: 'APPROVE' | 'REJECT') => void;
  onResult: (error?: unknown) => void;
}

const periodText = (item: TaskException): string => (item.valid_from === null ? '' : item.valid_to === null ? dayText(item.valid_from) : `${dayText(item.valid_from)} – ${dayText(item.valid_to)}`);

/** Exceptions of the task: a waiver of a missing requirement, a cancellation, a pause, an external delay; each is requested with a reason and decided by somebody else. */
export function ExceptionsSection({ task, canRequest, canDecide, prefill, onDecide, onResult }: ExceptionsProps) {
  const { t } = useTranslation();
  // What a waiver covers, by name: an item of the checklist, a legal document type or a form of the task; a code nothing names stays as it is.
  const itemName = (code: string): string => task.checklist.find((item) => item.item_code === code)?.name ?? task.form_templates.find((form) => form.code === code)?.current_title ?? docTypeName(t, code);
  const columns: DataTableColumn<TaskException>[] = [
    { key: 'kind', header: t('pwf.task.exception.col.kind'), render: (item) => exceptionWord(t, item.kind) },
    { key: 'items', header: t('pwf.task.exception.col.items'), render: (item) => item.items.map((code) => itemName(code)).join(', ') },
    { key: 'period', header: t('pwf.task.exception.col.period'), render: (item) => periodText(item) },
    { key: 'reason', header: t('pwf.task.exception.col.reason'), render: (item) => item.reason },
    {
      key: 'status',
      header: t('pwf.task.exception.col.status'),
      render: (item) => (
        <StatusPill tone={item.status === 'APPROVED' || item.status === 'USED' ? 'success' : item.status === 'REJECTED' ? 'danger' : 'warning'} icon={item.status === 'REJECTED' ? '✕' : item.status === 'REQUESTED' ? '…' : '✓'}>
          {exceptionStatusWord(t, item.status)}
        </StatusPill>
      ),
    },
    {
      key: 'people',
      header: t('pwf6.exception.col.people'),
      render: (item) => (
        <span className="pwf-cellstack">
          {typeof item.requested_by_name === 'string' && item.requested_by_name !== '' ? <span>{t('pwf6.exception.requestedBy.text', { name: item.requested_by_name })}</span> : null}
          {typeof item.decided_by_name === 'string' && item.decided_by_name !== '' ? <span>{t('pwf6.exception.decidedBy.text', { name: item.decided_by_name })}</span> : null}
        </span>
      ),
    },
    {
      key: 'decide',
      header: t('pwf.task.exception.col.decide'),
      render: (item) =>
        canDecide && item.status === 'REQUESTED' ? (
          <span className="pwf-pills">
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`approve-${item.id}`} onClick={() => onDecide(item, 'APPROVE')}>
              {t('pwf.task.exception.approve.action')}
            </button>
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`reject-${item.id}`} onClick={() => onDecide(item, 'REJECT')}>
              {t('pwf.task.exception.reject.action')}
            </button>
          </span>
        ) : null,
    },
  ];
  return (
    <SectionCard title={t('pwf.task.exception.title')}>
      <div data-testid="exceptions">
        {task.exceptions.length === 0 ? (
          <p className="pwf-hint" role="status" data-testid="exceptions-empty">
            {t('pwf.task.exception.empty')}
          </p>
        ) : (
          <div className="pwf-free">
            <DataTable columns={columns} rows={task.exceptions} rowKey={(item) => item.id} caption={t('pwf.task.exception.caption')} />
          </div>
        )}
        {canRequest ? (
          <details className="pwf-inline-fold" data-testid="exception-fold" open={prefill !== undefined}>
            <summary>{t('pwf.task.request.title')}</summary>
            <ExceptionRequestForm key={prefill?.seq ?? 0} task={task} initialItems={prefill?.items ?? ''} onResult={onResult} />
          </details>
        ) : null}
      </div>
    </SectionCard>
  );
}

const LIMITS: Readonly<Record<ExceptionField, { min?: number; max?: number }>> = { items: {}, validFrom: {}, validTo: {}, reason: { min: MIN_REASON } };

function ExceptionRequestForm({ task, initialItems, onResult }: { task: TaskDetail; initialItems: string; onResult: (error?: unknown) => void }) {
  const { t } = useTranslation();
  const request = useRequestException();
  const [form, setForm] = useState<ExceptionForm>({ ...EMPTY_EXCEPTION, items: initialItems });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateException(form);
  const error = (field: ExceptionField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemText(t, problem, LIMITS[field]) : undefined;
  };
  const change = (patch: Partial<ExceptionForm>): void => setForm({ ...form, ...patch });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (request.isPending || Object.keys(problems).length > 0) return;
    request.mutate(
      { taskId: task.id, body: exceptionBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_EXCEPTION);
          setSubmitted(false);
          onResult();
        },
        onError: onResult,
      },
    );
  };
  return (
    <form className="pwf-assign" onSubmit={submit} noValidate aria-label={t('pwf.task.request.title')} data-testid="exception-form">
      <div className="pwf-filters">
        <Field id="exception-kind" label={t('pwf.task.request.kind.label')} error={undefined} testKey="kind">
          <select id="exception-kind" data-testid="field-exception-kind" value={form.kind} onChange={(event) => change({ kind: EXCEPTION_KINDS.find((kind: ExceptionKind) => kind === event.target.value) ?? 'WAIVE_REQUIREMENT' })}>
            {EXCEPTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {exceptionWord(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === 'WAIVE_REQUIREMENT' ? (
          <Field id="exception-items" label={t('pwf.task.request.items.label')} hint={t('pwf.task.request.items.hint')} error={error('items')} testKey="items">
            <input id="exception-items" data-testid="field-items" value={form.items} onChange={(event) => change({ items: event.target.value })} {...problemAttributes('exception-items', error('items'))} />
          </Field>
        ) : null}
        <Field id="exception-from" label={t('pwf.task.request.from.label')} error={error('validFrom')} testKey="from">
          <input id="exception-from" type="date" data-testid="field-exception-from" value={form.validFrom} onChange={(event) => change({ validFrom: event.target.value })} {...problemAttributes('exception-from', error('validFrom'))} />
        </Field>
        <Field id="exception-to" label={t('pwf.task.request.to.label')} error={error('validTo')} testKey="to">
          <input id="exception-to" type="date" data-testid="field-exception-to" value={form.validTo} onChange={(event) => change({ validTo: event.target.value })} {...problemAttributes('exception-to', error('validTo'))} />
        </Field>
        <Field id="exception-ref" label={t('pwf.task.request.ref.label')} error={undefined} testKey="exception-ref">
          <input id="exception-ref" data-testid="field-exception-ref" value={form.evidenceRef} onChange={(event) => change({ evidenceRef: event.target.value })} />
        </Field>
        <Field id="exception-reason" label={t('pwf.task.request.reason.label')} hint={t('pwf.task.request.reason.hint', { min: MIN_REASON })} error={error('reason')} testKey="exception-reason" wide>
          <textarea id="exception-reason" rows={3} data-testid="field-exception-reason" value={form.reason} onChange={(event) => change({ reason: event.target.value })} {...problemAttributes('exception-reason', error('reason'))} />
        </Field>
      </div>
      <div className="pwf-actions">
        <button type="submit" className="ui-button ui-button--primary" data-testid="request" disabled={request.isPending}>
          {t('pwf.task.request.action')}
        </button>
      </div>
    </form>
  );
}
