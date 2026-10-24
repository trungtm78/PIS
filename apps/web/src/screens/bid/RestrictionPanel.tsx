import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useRecordRestriction } from './hooks';
import { fieldProblemMessage, kindLabel, problemMessage } from './labels';
import { EMPTY_RESTRICTION_FORM, RESTRICTION_KINDS, describeProblem, validateRestriction } from './model';
import type { FormErrors, RestrictionField, RestrictionForm, RestrictionKind } from './model';

/** The recording of a restriction on participation (BID-02): on a decision that is in force; a restriction in force blocks proposals and results. */
export default function RestrictionPanel({ contractorId }: { contractorId: string }) {
  const { t } = useTranslation();
  const record = useRecordRestriction();
  const [form, setForm] = useState<RestrictionForm>(EMPTY_RESTRICTION_FORM);
  const [errors, setErrors] = useState<FormErrors<RestrictionField>>({});
  const refused = record.isError ? describeProblem(record.error, 'restrict') : undefined;
  const error = (field: RestrictionField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };
  const setField = (field: RestrictionField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    record.reset();
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (record.isPending) return;
    const found = validateRestriction(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    record.mutate({ id: contractorId, form }, { onSuccess: () => setForm(EMPTY_RESTRICTION_FORM) });
  };

  return (
    <div className="card" data-testid="restriction-panel">
      <h2>{t('bid.restrict.panel.title')}</h2>
      <p className="sub">{t('bid.restrict.panel.hint')}</p>
      <form onSubmit={send} noValidate aria-label={t('bid.restrict.panel.title')}>
        {refused === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="restrict-refusal">
            {problemMessage(t, refused)}
          </p>
        )}
        {record.isSuccess ? (
          <p className="callout" role="status" data-testid="restrict-done">
            {t('bid.restrict.done.notice')}
          </p>
        ) : null}
        <div className="formgrid">
          <Field id="restrict-kind" label={t('bid.restrict.kind.label')} error={undefined}>
            <select
              id="restrict-kind"
              value={form.kind}
              onChange={(event) => {
                setForm({ ...form, kind: event.target.value as RestrictionKind });
                record.reset();
              }}
            >
              {RESTRICTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(t, kind)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="restrict-from" label={t('bid.restrict.from.label')} error={error('effectiveFrom')}>
            <input id="restrict-from" type="date" value={form.effectiveFrom} aria-invalid={error('effectiveFrom') !== undefined} onChange={(event) => setField('effectiveFrom', event.target.value)} />
          </Field>
          <Field id="restrict-until" label={t('bid.restrict.until.label')} error={error('effectiveUntil')} hint={t('bid.restrict.until.hint')}>
            <input id="restrict-until" type="date" value={form.effectiveUntil} aria-invalid={error('effectiveUntil') !== undefined} onChange={(event) => setField('effectiveUntil', event.target.value)} />
          </Field>
          <Field id="restrict-decision" label={t('bid.restrict.decision.label')} error={error('decisionDocumentId')} hint={t('bid.restrict.decision.hint')}>
            <input id="restrict-decision" value={form.decisionDocumentId} aria-invalid={error('decisionDocumentId') !== undefined} onChange={(event) => setField('decisionDocumentId', event.target.value)} />
          </Field>
          <Field id="restrict-note" label={t('bid.restrict.note.label')} error={error('note')}>
            <textarea id="restrict-note" rows={2} value={form.note} aria-invalid={error('note') !== undefined} onChange={(event) => setField('note', event.target.value)} />
          </Field>
        </div>
        <div className="formfooter">
          <button type="submit" className="primary" disabled={record.isPending}>
            {t('bid.restrict.submit.action')}
          </button>
        </div>
      </form>
    </div>
  );
}
