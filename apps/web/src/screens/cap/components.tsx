import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { SectionCard, StatusPill, StickyActions } from '../../ui';
import { decisionKindLabel, fieldProblemMessage, levelLabel, originLabel, statusLabel } from './labels';
import { decisionKindsOf, formLevelsOf, formOriginsOf, millionsText, vndOfMillions, vndText } from './model';
import type { AppropriationForm, AppropriationLine, BudgetLevel, FieldProblem, FormField, MasterOption, Origin } from './model';
import './cap.css';

/** An amount of whole VND shown in millions of dong, exactly; the exact VND is the tooltip so nothing is hidden by the unit. */
export function Money({ vnd }: { vnd: string }) {
  const { locale } = useTranslation();
  return (
    <span className="cap-money" title={vndText(vnd, locale)} data-vnd={vnd}>
      {millionsText(vnd, locale)}
    </span>
  );
}

/** The origin of the capital as a badge: the text carries the meaning, the border only repeats it. */
export function OriginBadge({ origin }: { origin: Origin }) {
  const { t } = useTranslation();
  return (
    <span data-origin={origin}>
      <StatusPill tone="info">{originLabel(t, origin)}</StatusPill>
    </span>
  );
}

export function StatusBadge({ line }: { line: AppropriationLine }) {
  const { t } = useTranslation();
  return (
    <span data-status={line.status}>
      <StatusPill tone={line.status === 'PUBLISHED' ? 'success' : line.status === 'REJECTED' ? 'danger' : line.status === 'SUPERSEDED' ? 'neutral' : 'warning'}>{statusLabel(t, line.status)}</StatusPill>
    </span>
  );
}

/** The citation of the decision that assigned the capital: its symbol and date, or a note when the document carries none. */
export function Citation({ line }: { line: AppropriationLine }) {
  const { t } = useTranslation();
  return (
    <span>
      {line.decisionSymbol === null
        ? t('cap.decision.noSymbol.label')
        : line.decisionIssuedOn === null
          ? line.decisionSymbol
          : t('cap.decision.citation.label', {
              symbol: line.decisionSymbol,
              date: line.decisionIssuedOn,
            })}
    </span>
  );
}

export interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

export interface FormPanelProps {
  title: string;
  form: AppropriationForm;
  errors: Partial<Record<FormField, FieldProblem>>;
  funds: readonly MasterOption[];
  programs: readonly MasterOption[];
  /** A revision keeps what identifies the appropriation it replaces: only the amount, the document and the authority change. */
  revision: boolean;
  /** Whether the edition is the enterprise one: its pack lists other origins, the single level and a kind of decision document. */
  enterprise?: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (field: FormField, value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}

/** The form that registers an appropriation, or a revision of a published one. The amount is typed in millions of dong and sent as exact VND. */
export function FormPanel({ title, form, errors, funds, programs, revision, enterprise = false, disabled, pending, onChange, onSubmit, onCancel }: FormPanelProps) {
  const { t, locale } = useTranslation();
  const error = (field: FormField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };
  const exact = vndOfMillions(form.amount, locale);
  const locked = disabled || revision;
  const carryover = form.origin === 'CARRYOVER';
  return (
    <form className="cap-form" onSubmit={onSubmit} noValidate aria-label={title}>
      <SectionCard title={title}>
        <fieldset disabled={locked} className="formgrid">
          <Field id="cap-fund" label={t('cap.form.fund.label')} error={error('fundSourceVersionId')}>
            <select id="cap-fund" value={form.fundSourceVersionId} aria-invalid={error('fundSourceVersionId') !== undefined} onChange={(event) => onChange('fundSourceVersionId', event.target.value)}>
              <option value="">{t('cap.form.choose.option')}</option>
              {funds.map((fund) => (
                <option key={fund.versionId} value={fund.versionId}>
                  {fund.businessKey} · {fund.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="cap-program" label={t('cap.form.program.label')} error={undefined}>
            <select id="cap-program" value={form.programVersionId} onChange={(event) => onChange('programVersionId', event.target.value)}>
              <option value="">{t('cap.form.choose.option')}</option>
              {programs.map((program) => (
                <option key={program.versionId} value={program.versionId}>
                  {program.businessKey} · {program.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="cap-year" label={t('cap.form.year.label')} error={error('planYear')}>
            <input id="cap-year" inputMode="numeric" value={form.planYear} aria-invalid={error('planYear') !== undefined} onChange={(event) => onChange('planYear', event.target.value)} />
          </Field>
          <Field id="cap-origin" label={t('cap.form.origin.label')} error={undefined}>
            <select id="cap-origin" value={form.origin} onChange={(event) => onChange('origin', event.target.value)}>
              {formOriginsOf(enterprise).map((origin) => (
                <option key={origin} value={origin}>
                  {originLabel(t, origin)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="cap-level" label={t('cap.form.level.label')} error={undefined}>
            <select id="cap-level" value={form.budgetLevel} onChange={(event) => onChange('budgetLevel', event.target.value)}>
              {formLevelsOf(enterprise).map((level: BudgetLevel) => (
                <option key={level} value={level}>
                  {levelLabel(t, level)}
                </option>
              ))}
            </select>
          </Field>
          {enterprise ? (
            <Field id="cap-decision-kind" label={t('cap.form.decisionKind.label')} error={error('decisionKind')} hint={t('cap.form.decisionKind.hint')}>
              <select id="cap-decision-kind" value={form.decisionKind} aria-invalid={error('decisionKind') !== undefined} onChange={(event) => onChange('decisionKind', event.target.value)}>
                {decisionKindsOf(form.origin).map((kind) => (
                  <option key={kind} value={kind}>
                    {decisionKindLabel(t, kind)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {carryover ? (
            <Field id="cap-source-year" label={t('cap.form.sourceYear.label')} error={error('sourceYear')} hint={t('cap.form.sourceYear.hint')}>
              <input id="cap-source-year" inputMode="numeric" value={form.sourceYear} aria-invalid={error('sourceYear') !== undefined} onChange={(event) => onChange('sourceYear', event.target.value)} />
            </Field>
          ) : null}
        </fieldset>
        <fieldset disabled={disabled} className="formgrid">
          <Field id="cap-amount" label={t('cap.form.amount.label')} error={error('amount')} hint={t('cap.form.amount.hint')}>
            <input
              id="cap-amount"
              inputMode="decimal"
              value={form.amount}
              aria-invalid={error('amount') !== undefined}
              aria-describedby="cap-amount-exact"
              onChange={(event) => onChange('amount', event.target.value)}
            />
          </Field>
          <p id="cap-amount-exact" className="cap-exact" role="status" data-testid="exact-amount">
            {exact === undefined
              ? t('cap.form.amountExact.empty')
              : t('cap.form.amountExact.text', {
                  amount: vndText(exact, locale),
                })}
          </p>
          <Field id="cap-decision" label={t('cap.form.decision.label')} error={error('decisionDocumentId')} hint={t('cap.form.decision.hint')}>
            <input id="cap-decision" value={form.decisionDocumentId} aria-invalid={error('decisionDocumentId') !== undefined} onChange={(event) => onChange('decisionDocumentId', event.target.value)} />
          </Field>
          <Field id="cap-authority" label={t('cap.form.authority.label')} error={error('issuingAuthority')}>
            <input id="cap-authority" value={form.issuingAuthority} aria-invalid={error('issuingAuthority') !== undefined} onChange={(event) => onChange('issuingAuthority', event.target.value)} />
          </Field>
          {carryover ? (
            <>
              <Field id="cap-extension" label={t('cap.form.extension.label')} error={error('extensionDocumentId')}>
                <input id="cap-extension" value={form.extensionDocumentId} aria-invalid={error('extensionDocumentId') !== undefined} onChange={(event) => onChange('extensionDocumentId', event.target.value)} />
              </Field>
              <Field id="cap-extended-to" label={t('cap.form.extendedTo.label')} error={error('extendedTo')} hint={t('cap.form.extendedTo.hint')}>
                <input id="cap-extended-to" type="date" value={form.extendedTo} aria-invalid={error('extendedTo') !== undefined} onChange={(event) => onChange('extendedTo', event.target.value)} />
              </Field>
            </>
          ) : null}
        </fieldset>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={disabled || pending}>
              {pending ? t('cap.form.submit.pending') : t('cap.form.submit.action')}
            </button>
          }
          secondary={[
            <button key="cancel" type="button" className="ui-button ui-button--outline" onClick={onCancel}>
              {t('cap.form.cancel.action')}
            </button>,
          ]}
        />
      </SectionCard>
    </form>
  );
}
