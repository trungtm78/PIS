import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useCreateCriteria } from './criteria-hooks';
import { criteriaFieldMessage, criteriaProblemMessage, criterionKindLabel } from './criteria-labels';
import { BASIS_MAX, CRITERION_KINDS, MAX_CRITERIA, TOTAL_WEIGHT, describeProblem, emptyForm, emptyRow, hasErrors, hasScored, rowsOf, validateCriteria, weightsTotal } from './criteria-model';
import type { CriteriaErrors, CriteriaForm as CriteriaFormValue, CriteriaVersion, CriterionKind, CriterionRow, FieldProblem } from './criteria-model';
import './bid.css';

export interface CriteriaFormProps {
  packageId: string;
  /** The version the screen shows: the start of the next revision, when the planner asks for it. */
  shown: CriteriaVersion | undefined;
  /** The draft in work, which the new revision takes the place of. */
  draft: CriteriaVersion | undefined;
}

/**
 * The editor of the criteria of a package (BID-04). A version is never edited once made: a change is the next revision, which takes the place of
 * the draft in work and, once approved, of the version in force. The running sum of the weights is shown while typing so the planner sees the
 * figure first; what only the server can judge (the criteria nobody may ask for) comes back as a refusal that names the criterion and the legal basis.
 */
export function CriteriaForm({ packageId, shown, draft }: CriteriaFormProps) {
  const { t } = useTranslation();
  const create = useCreateCriteria();
  const [form, setForm] = useState<CriteriaFormValue>(() => emptyForm(packageId));
  const [errors, setErrors] = useState<CriteriaErrors>({ items: {} });
  const [saved, setSaved] = useState(false);
  const refused = create.isError ? describeProblem(create.error) : undefined;
  const total = weightsTotal(form.rows);
  const scored = hasScored(form.rows);

  const touch = (): void => {
    setSaved(false);
    if (create.isError) create.reset();
  };
  const setBasis = (value: string): void => {
    setForm((previous) => ({ ...previous, legalBasis: value }));
    setErrors((previous) => ({ ...previous, legalBasis: undefined }));
    touch();
  };
  const setRow = (key: string, change: Partial<CriterionRow>): void => {
    setForm((previous) => ({ ...previous, rows: previous.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
    setErrors((previous) => ({ ...previous, rows: undefined, items: { ...previous.items, [key]: {} } }));
    touch();
  };
  const message = (problem: FieldProblem | undefined): string | undefined => (problem === undefined ? undefined : criteriaFieldMessage(t, problem));

  const startFromShown = (): void => {
    if (shown === undefined) return;
    setForm({ packageId, legalBasis: shown.legalBasis ?? '', rows: rowsOf(shown) });
    setErrors({ items: {} });
    touch();
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateCriteria({ ...form, packageId });
    setErrors(found);
    if (hasErrors(found)) return;
    create.mutate(
      { ...form, packageId },
      {
        onSuccess: () => {
          setForm(emptyForm(packageId));
          setSaved(true);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('bid.criteria.form.aria')} data-testid="criteria-form">
      <h2>{t('bid.criteria.form.title')}</h2>
      <p className="sub">{t('bid.criteria.form.hint')}</p>
      {draft === undefined ? null : (
        <p className="callout" role="status" data-testid="replaces-draft">
          {t('bid.criteria.form.replaces.notice', { revision: draft.revision })}
        </p>
      )}
      {refused === undefined ? null : (
        <div className="callout warning" role="alert" data-testid="create-refusal" data-reason={refused.reason}>
          <p>{criteriaProblemMessage(t, refused)}</p>
          {refused.legalBasis === undefined ? null : <p className="sub">{t('bid.criteria.problem.basis.text', { basis: refused.legalBasis })}</p>}
        </div>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('bid.criteria.form.saved.notice')}
        </p>
      ) : null}
      <Field id="criteria-basis" label={t('bid.criteria.form.basis.label')} error={message(errors.legalBasis)} hint={t('bid.criteria.form.basis.hint', { max: BASIS_MAX })}>
        <textarea id="criteria-basis" rows={2} value={form.legalBasis} aria-invalid={errors.legalBasis !== undefined} onChange={(event) => setBasis(event.target.value)} />
      </Field>
      <h3>{t('bid.criteria.form.rows.title')}</h3>
      {errors.rows === undefined ? null : (
        <p role="alert" className="field-error" data-testid="rows-error">
          {message(errors.rows)}
        </p>
      )}
      {form.rows.map((row, index) => (
        <fieldset key={row.key} className="bid-package-row" data-testid="criterion-row" aria-label={t('bid.criteria.row.title', { number: index + 1 })}>
          <legend>{t('bid.criteria.row.title', { number: index + 1 })}</legend>
          <div className="formgrid">
            <RowInput id={`${row.key}-code`} label={t('bid.criteria.row.code')} value={row.code} error={message(errors.items[row.key]?.code)} onChange={(value) => setRow(row.key, { code: value })} />
            <RowInput id={`${row.key}-name`} label={t('bid.criteria.row.name')} value={row.name} error={message(errors.items[row.key]?.name)} onChange={(value) => setRow(row.key, { name: value })} />
            <Field id={`${row.key}-kind`} label={t('bid.criteria.row.kind')} error={undefined}>
              <select id={`${row.key}-kind`} value={row.kind} onChange={(event) => setRow(row.key, { kind: event.target.value as CriterionKind })}>
                {CRITERION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {criterionKindLabel(t, kind)}
                  </option>
                ))}
              </select>
            </Field>
            {row.kind === 'SCORED' ? (
              <>
                <RowInput id={`${row.key}-weight`} label={t('bid.criteria.row.weight')} value={row.weight} inputMode="numeric" error={message(errors.items[row.key]?.weight)} onChange={(value) => setRow(row.key, { weight: value })} />
                <RowInput id={`${row.key}-scale`} label={t('bid.criteria.row.scale')} value={row.maxScore} inputMode="numeric" error={message(errors.items[row.key]?.maxScore)} onChange={(value) => setRow(row.key, { maxScore: value })} />
                <RowInput
                  id={`${row.key}-threshold`}
                  label={t('bid.criteria.row.threshold')}
                  hint={t('bid.criteria.row.thresholdHint')}
                  value={row.threshold}
                  inputMode="numeric"
                  error={message(errors.items[row.key]?.threshold)}
                  onChange={(value) => setRow(row.key, { threshold: value })}
                />
              </>
            ) : null}
            <Field id={`${row.key}-evidence`} label={t('bid.criteria.row.evidence')} error={message(errors.items[row.key]?.evidence)} hint={t('bid.criteria.row.evidenceHint')}>
              <textarea id={`${row.key}-evidence`} rows={2} value={row.evidence} aria-invalid={errors.items[row.key]?.evidence !== undefined} onChange={(event) => setRow(row.key, { evidence: event.target.value })} />
            </Field>
          </div>
          <label htmlFor={`${row.key}-mandatory`}>
            <input id={`${row.key}-mandatory`} type="checkbox" checked={row.mandatory} onChange={(event) => setRow(row.key, { mandatory: event.target.checked })} /> {t('bid.criteria.row.mandatory')}
          </label>{' '}
          <button
            type="button"
            disabled={form.rows.length === 1}
            onClick={() => {
              setForm((previous) => ({ ...previous, rows: previous.rows.filter((other) => other.key !== row.key) }));
              touch();
            }}
          >
            {t('bid.criteria.row.remove')}
          </button>
        </fieldset>
      ))}
      <div className="formfooter">
        <button
          type="button"
          disabled={form.rows.length >= MAX_CRITERIA}
          onClick={() => {
            setForm((previous) => ({ ...previous, rows: [...previous.rows, emptyRow()] }));
            touch();
          }}
        >
          {t('bid.criteria.row.add')}
        </button>
        {shown === undefined ? null : (
          <button type="button" onClick={startFromShown}>
            {t('bid.criteria.form.start.action', { revision: shown.revision })}
          </button>
        )}
        <p className="sub" data-testid="running-total" data-total={total} data-complete={!scored || total === TOTAL_WEIGHT}>
          {scored ? t('bid.criteria.total.text', { total, expected: TOTAL_WEIGHT }) : t('bid.criteria.total.none.text')}
        </p>
        <button type="submit" className="primary" disabled={create.isPending}>
          {create.isPending ? t('bid.criteria.form.submit.pending') : t('bid.criteria.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function RowInput({ id, label, hint, value, error, inputMode, onChange }: { id: string; label: string; hint?: string; value: string; error: string | undefined; inputMode?: 'numeric'; onChange: (value: string) => void }) {
  return (
    <Field id={id} label={label} error={error} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={value} aria-invalid={error !== undefined} {...(inputMode === undefined ? {} : { inputMode })} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

