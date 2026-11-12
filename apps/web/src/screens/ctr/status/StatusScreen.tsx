import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { wireControl } from '../../field-wiring';
import { BackLink, StatusBadge, DefaultContractBar } from '../components';
import { useContractChoice } from '../hooks';
import { LIST_PATH, amountText } from '../model';
import { useSummary } from '../workspace/hooks';
import { formProblemMessage, problemMessage } from '../workspace/labels';
import { HALT_ACTIONS, MAX_TEXT, describeProblem, vietnamToday } from '../workspace/model';
import type { FormProblem, HaltAction, Summary } from '../workspace/model';
import { Field } from '../workspace/WorkspaceDialogs';
import { useHalt } from './hooks';
import { actionLabel, dayLabel, guaranteeLabel, impactLabel, submitLabel } from './labels';
import { GUARANTEE_ACTIONS, emptyHalt, haltBody, validateHalt } from './model';
import type { GuaranteeAction, HaltForm } from './model';
import '../ctr.css';
import { SectionCard } from '../../../ui';

/**
 * CTR-22: suspend, resume or terminate a contract (ST-CTR-005, CTR 3.2). The person chooses among the actions that apply to the status of the contract and that they may take, says why,
 * names the decision document and the day, and reads what the command does to the payments before they run it. A termination cannot be undone and says what becomes of the
 * performance guarantee; it asks the person to confirm. The server judges the command again: the decision document, the delegation limit, the proposer who may not approve, and the
 * conflict of interest.
 */
export default function StatusScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The summary and the form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <StatusContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function StatusContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  // Opened without a contract in the address (the menu), the largest contract in force is shown, and the selector stays to change it.
  const choice = useContractChoice('id');
  const contractId = choice.contractId;
  const summary = useSummary(contractId);
  const [done, setDone] = useState(false);
  const state = useScreenState({
    isLoading: summary.isLoading,
    error: summary.error,
    data: contractId === null ? null : summary.data,
    isEmpty: (data) => data === null || data === undefined,
  });
  const today = vietnamToday(new Date());

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.halt.page.title')}</h1>
          <p>{t('ctr.halt.page.subtitle')}</p>
        </div>
      </div>
      <BackLink to={LIST_PATH}>{t('ctr.back.list.link')}</BackLink>
      <DefaultContractBar choice={choice} />
      {choice.isLoading ? (
        <StateBoundary state="loading" />
      ) : contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('ctr.halt.none.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void summary.refetch()}>
          {summary.data === null || summary.data === undefined ? null : (
            <Halt key={`${summary.data.contract.id}:${summary.data.contract.version}`} summary={summary.data} locale={locale} today={today} readOnly={mode === 'READ_ONLY'} done={done} onDone={() => setDone(true)} />
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.halt.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface HaltProps {
  summary: Summary;
  locale: string;
  today: string;
  readOnly: boolean;
  done: boolean;
  onDone(): void;
}

function Halt({ summary, locale, today, readOnly, done, onDone }: HaltProps) {
  const { t } = useTranslation();
  const { contract } = summary;
  const allowed = HALT_ACTIONS.filter((action) => !readOnly && summary.halts?.[action] === true);
  const halt = useHalt();
  const [form, setForm] = useState<HaltForm>(emptyHalt(today, allowed.length === 1 ? (allowed[0] ?? '') : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateHalt(form, today);
  const shown = (field: keyof HaltForm): FormProblem | undefined => (submitted ? problems[field] : undefined);
  const choose = (action: HaltAction): void => setForm({ ...emptyHalt(today, action), reason: form.reason, documentVersionId: form.documentVersionId });

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (halt.isPending || form.action === '' || Object.keys(problems).length > 0) return;
    halt.mutate({ action: form.action, id: contract.id, version: contract.version, body: haltBody(form) }, { onSuccess: onDone });
  };

  return (
    <div className="ctr-grid">
      <div>
        <SectionCard title={t('ctr.halt.contract.title')}>
          <p>
            <strong data-testid="contract-code">{contract.code}</strong> · {contract.title ?? t('ctr.workspace.none.text')} <StatusBadge status={contract.status} />
          </p>
          <dl className="ctr-facts" data-testid="facts">
            <dt>{t('ctr.workspace.fact.project')}</dt>
            <dd>{`${contract.projectCode} · ${contract.projectName}`}</dd>
            <dt>{t('ctr.workspace.fact.contractor')}</dt>
            <dd>{contract.contractorName ?? t('ctr.workspace.none.text')}</dd>
            <dt>{t('ctr.workspace.fact.value')}</dt>
            <dd data-testid="value">{t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) })}</dd>
            <dt>{t('ctr.workspace.fact.due')}</dt>
            <dd>{contract.completionDue ?? t('ctr.workspace.none.text')}</dd>
          </dl>
        </SectionCard>
        {done ? (
          <p className="callout" role="status" data-testid="done">
            {t('ctr.halt.done.notice')}
          </p>
        ) : null}
      </div>
      {allowed.length === 0 ? (
        <article className="card">
          <p className="callout" role="status" data-testid="no-command">
            {readOnly ? t('ctr.workspace.readOnly.notice') : t('ctr.workspace.noCommand.notice')}
          </p>
        </article>
      ) : (
        <SectionCard title={t('ctr.halt.form.title')}>
          <form onSubmit={send} noValidate>
            {halt.isError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(halt.error))}
              </p>
            ) : null}
            <fieldset className="field" data-field="halt-action">
              <legend>{t('ctr.halt.action.legend')}</legend>
              {allowed.map((action) => (
                <label key={action} className="radio">
                  <input type="radio" name="halt-action" value={action} data-action={action} checked={form.action === action} onChange={() => choose(action)} /> {actionLabel(t, action)}
                </label>
              ))}
              {shown('action') === undefined ? null : (
                <small role="alert" className="field-error">
                  {formProblemMessage(t, 'required')}
                </small>
              )}
            </fieldset>
            {form.action === '' ? null : (
              <>
                <Field id="halt-reason" label={t('ctr.halt.field.reason')} problem={shown('reason')}>
                  {wireControl(<textarea id="halt-reason" rows={3} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />, 'halt-reason', {
                    hint: false,
                    error: shown('reason') !== undefined,
                  })}
                </Field>
                <div className="formgrid">
                  <Field id="halt-document" label={t('ctr.halt.field.document')} problem={shown('documentVersionId')} hint={t('ctr.halt.field.document.hint')}>
                    {wireControl(<input id="halt-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />, 'halt-document', {
                      hint: false,
                      error: shown('documentVersionId') !== undefined,
                    })}
                  </Field>
                  <Field id="halt-day" label={dayLabel(t, form.action)} problem={shown('day')}>
                    {wireControl(<input id="halt-day" type="date" value={form.day} onChange={(event) => setForm({ ...form, day: event.target.value })} />, 'halt-day', { hint: false, error: shown('day') !== undefined })}
                  </Field>
                  {form.action === 'resume' ? (
                    <Field id="halt-extension" label={t('ctr.halt.field.extension')} problem={shown('extensionDays')} hint={t('ctr.halt.field.extension.hint')}>
                      {wireControl(
                        <input id="halt-extension" inputMode="numeric" autoComplete="off" value={form.extensionDays} onChange={(event) => setForm({ ...form, extensionDays: event.target.value })} />,
                        'halt-extension',
                        { hint: false, error: shown('extensionDays') !== undefined },
                      )}
                    </Field>
                  ) : null}
                  {form.action === 'terminate' ? (
                    <Field id="halt-guarantee" label={t('ctr.halt.field.guarantee')} problem={shown('guaranteeAction')} hint={t('ctr.halt.field.guarantee.hint')}>
                      {wireControl(
                        <select id="halt-guarantee" value={form.guaranteeAction} onChange={(event) => setForm({ ...form, guaranteeAction: GUARANTEE_ACTIONS.find((value) => value === event.target.value) ?? '' })}>
                          <option value="">{t('ctr.halt.field.guarantee.choose')}</option>
                          {GUARANTEE_ACTIONS.map((value: GuaranteeAction) => (
                            <option key={value} value={value}>
                              {guaranteeLabel(t, value)}
                            </option>
                          ))}
                        </select>,
                        'halt-guarantee',
                        { hint: false, error: shown('guaranteeAction') !== undefined },
                      )}
                    </Field>
                  ) : null}
                </div>
                <p className="callout" data-testid="impact">
                  <strong>{t('ctr.halt.impact.title')}</strong> {impactLabel(t, form.action)}
                </p>
                {form.action === 'terminate' ? (
                  <>
                    <p className="callout warning" role="alert" data-testid="irreversible">
                      {t('ctr.halt.irreversible.notice')}
                    </p>
                    <div className="field" data-field="halt-confirm">
                      <label htmlFor="halt-confirm">
                        <input id="halt-confirm" type="checkbox" checked={form.confirmed} onChange={(event) => setForm({ ...form, confirmed: event.target.checked })} /> {t('ctr.halt.confirm.label')}
                      </label>
                      {shown('confirmed') === undefined ? null : (
                        <small role="alert" className="field-error">
                          {formProblemMessage(t, 'confirm')}
                        </small>
                      )}
                    </div>
                  </>
                ) : null}
                <div className="formfooter">
                  <button type="submit" className="primary" disabled={halt.isPending}>
                    {halt.isPending ? t('ctr.workspace.dialog.pending') : submitLabel(t, form.action)}
                  </button>
                </div>
              </>
            )}
          </form>
        </SectionCard>
      )}
    </div>
  );
}
