import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import '../pay.css';
import { formProblemLabel, formStatusLabel, refusalLabel, stageLabel } from './forms-labels';
import { DECISION_FORM, EMPTY_GENERATE, GENERATE_PERMISSION, PLACE_MAX, calendarOf, describeRefusal, formsOf, generateBody, standing, validateGenerate } from './forms-model';
import type { GenerateForm } from './forms-model';
import { useAllSettlements, useGenerateSettlementForms, useSettlement, useSettlementForms } from './hooks';
import { scopeLabel } from './labels';
import { READ_PERMISSION, settlementLink, vietnamDay } from './model';
import type { Settlement } from './model';

/**
 * PAY-16: the forms of a settlement and the calendar of its verification (ST-PAY-012, PAY 3.5 steps 3 and 4, CXN-09, UAT-AC340). The calendar lists the settlements that were sent and wait for their verification by the
 * last day of it, with the days left and the stage of the reminders (30 days, 7 days, overdue). The forms are those of a settlement that is verified, of a year (01 to 05/QTNĐ) or of a completed project (01 to 12/QTDA): drawn
 * by DOC from the template in force that is confirmed, kept with the revision, the legal basis and the hash of the file. A template that waits for its confirmation is refused by name; the server judges every command again.
 */
export default function SettlementFormsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The screen belongs to one membership: a switch of tenant or of membership starts it over.
  return <SettlementFormsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SettlementFormsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_PERMISSION);
  const mayGenerate = holds(GENERATE_PERMISSION) && mode !== 'READ_ONLY';
  const [search, setSearch] = useSearchParams();
  const picked = search.get('settlement');
  const list = useAllSettlements(mayRead);
  const detail = useSettlement(picked, mayRead && picked !== null);
  const forms = useSettlementForms(picked, mayRead && picked !== null);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const today = vietnamDay(new Date());
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const settlements = list.data ?? [];
  const calendar = calendarOf(settlements, today);
  // The settlement chosen is read by itself as well, so a direct link to one that is not among those listed still shows its forms and can draw them.
  const current = detail.data ?? settlements.find((settlement) => settlement.id === picked);
  const verified = settlements.filter((settlement) => settlement.status === 'VERIFIED' && formsOf(settlement.scope).length > 0);
  const choices = current !== undefined && current.status === 'VERIFIED' && formsOf(current.scope).length > 0 && !verified.some((settlement) => settlement.id === current.id) ? [current, ...verified] : verified;
  const choose = (id: string): void => {
    setDone(false);
    setAsking(false);
    setSearch(id === '' ? {} : { settlement: id });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.sform.title')}</h1>
          <p>{t('pay.sform.subtitle')}</p>
        </div>
      </div>
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.sform.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <article className="card" aria-label={t('pay.sform.calendar.title')}>
            <h2>{t('pay.sform.calendar.title')}</h2>
            {calendar.length === 0 ? (
              <p className="sub" role="status" data-testid="calendar-empty">
                {t('pay.sform.calendar.empty')}
              </p>
            ) : (
              <table className="table" data-testid="calendar">
                <thead>
                  <tr>
                    <th scope="col">{t('pay.sform.column.project')}</th>
                    <th scope="col">{t('pay.sform.column.scope')}</th>
                    <th scope="col">{t('pay.sform.column.submitted')}</th>
                    <th scope="col">{t('pay.sform.column.due')}</th>
                    <th scope="col" className="pay-amount">
                      {t('pay.sform.column.left')}
                    </th>
                    <th scope="col">{t('pay.sform.column.stage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {calendar.map((line) => (
                    <tr key={line.settlement.id} data-settlement={line.settlement.id} data-stage={line.stage}>
                      <td>
                        <Link to={settlementLink(line.settlement.id)} data-testid="settlement-link">
                          {line.settlement.projectCode}
                        </Link>
                      </td>
                      <td>{scopeLabel(t, line.settlement.scope)}</td>
                      <td data-testid="submitted">{line.settlement.submittedOn ?? ''}</td>
                      <td data-testid="due">{line.dueOn}</td>
                      <td className="pay-amount" data-testid="left">
                        {line.daysLeft}
                      </td>
                      <td>
                        <span className={line.stage === 'OVERDUE' || line.stage === 'T7' ? 'pay-badge warning' : 'pay-badge'} data-testid="stage">
                          {stageLabel(t, line.stage)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
          <article className="card" aria-label={t('pay.sform.forms.title')}>
            <h2>{t('pay.sform.forms.title')}</h2>
            <div className="field">
              <label htmlFor="sform-settlement">{t('pay.sform.forms.pick')}</label>
              <select id="sform-settlement" value={picked ?? ''} onChange={(event) => choose(event.target.value)}>
                <option value="">{t('pay.sform.forms.choose')}</option>
                {choices.map((settlement) => (
                  <option key={settlement.id} value={settlement.id}>
                    {optionText(settlement, t('pay.sform.forms.year'))}
                  </option>
                ))}
              </select>
            </div>
            {done ? (
              <p className="callout" role="status" data-testid="done">
                {t('pay.sform.done')}
              </p>
            ) : null}
            {picked === null ? (
              <p className="sub" role="status" data-testid="choose">
                {t('pay.sform.forms.notice')}
              </p>
            ) : forms.isLoading ? (
              <p className="sub" role="status">
                {t('pay.sform.forms.loading')}
              </p>
            ) : forms.data === null || forms.data === undefined ? (
              <p className="callout warning" role="alert" data-testid="forms-missing">
                {t('pay.sform.forms.missing')}
              </p>
            ) : (
              <>
                {mayGenerate && current !== undefined && current.status === 'VERIFIED' && formsOf(current.scope).length > 0 ? (
                  <button type="button" className="primary" data-action="generate" onClick={() => setAsking(true)}>
                    {t('pay.sform.generate.action')}
                  </button>
                ) : null}
                {forms.data.length === 0 ? (
                  <p className="sub" role="status" data-testid="forms-empty">
                    {t('pay.sform.forms.empty')}
                  </p>
                ) : (
                  <table className="table" data-testid="forms">
                    <thead>
                      <tr>
                        <th scope="col">{t('pay.sform.column.form')}</th>
                        <th scope="col">{t('pay.sform.column.status')}</th>
                        <th scope="col">{t('pay.sform.column.template')}</th>
                        <th scope="col">{t('pay.sform.column.basis')}</th>
                        <th scope="col">{t('pay.sform.column.hash')}</th>
                        <th scope="col">{t('pay.sform.column.generated')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forms.data.map((form) => (
                        <tr key={form.id} data-form={form.formCode} data-status={form.status}>
                          <td>
                            {form.formCode}
                            {form.formCode === DECISION_FORM ? (
                              <small className="sub" data-testid="decision-note">
                                {' '}
                                {t('pay.sform.decision.note')}
                              </small>
                            ) : null}
                          </td>
                          <td>
                            <span className={form.status === 'GENERATED' ? 'pay-badge' : 'pay-badge warning'} data-testid="form-status">
                              {formStatusLabel(t, form.status)}
                            </span>
                          </td>
                          <td data-testid="template">{form.templateCode === null ? '' : `${form.templateCode} · ${form.templateRevision ?? ''}`}</td>
                          <td data-testid="basis">{form.legalBasis}</td>
                          <td data-testid="hash">
                            <code>{form.fileSha256 === null ? '' : form.fileSha256.slice(0, 12)}</code>
                          </td>
                          <td data-testid="generated">{form.generatedAt ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {forms.data.length > 0 ? (
                  <p className="sub" data-testid="standing">
                    {t('pay.sform.standing', { n: standing(forms.data).length })}
                  </p>
                ) : null}
              </>
            )}
          </article>
        </StateBoundary>
      )}
      {asking && current !== undefined && mayGenerate ? (
        <GenerateDialog
          settlement={current}
          onDone={() => {
            setAsking(false);
            setDone(true);
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
      <p className="prototype-note">{t('pay.sform.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const optionText = (settlement: Settlement, year: string): string => `${settlement.projectCode} · ${settlement.scope === 'ANNUAL' ? `${year} ${settlement.fiscalYear ?? ''} · ` : ''}${settlement.revision}`;

/** Drawing the forms: the codes of the scope of the settlement and the place of the place-and-date line; the server draws all or none and names the form it refuses. */
function GenerateDialog({ settlement, onDone, onClose }: { settlement: Settlement; onDone(): void; onClose(): void }) {
  const { t } = useTranslation();
  const generate = useGenerateSettlementForms();
  const [form, setForm] = useState<GenerateForm>(EMPTY_GENERATE);
  const [sent, setSent] = useState(false);
  const problems = validateGenerate(form, settlement.scope);
  const toggle = (code: string): void => setForm({ ...form, codes: form.codes.includes(code) ? form.codes.filter((candidate) => candidate !== code) : [...form.codes, code] });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (generate.isPending || Object.keys(problems).length > 0) return;
    generate.mutate({ id: settlement.id, body: generateBody(form, settlement.scope) }, { onSuccess: onDone });
  };
  const words = { close: t('pay.sform.dialog.close'), cancel: t('pay.sform.dialog.cancel'), pending: t('pay.sform.dialog.pending') };
  return (
    <CommandFrame
      title={t('pay.sform.generate.title', { project: settlement.projectCode })}
      refusal={generate.isError ? refusalLabel(t, describeRefusal(generate.error)) : undefined}
      pending={generate.isPending}
      submitLabel={t('pay.sform.generate.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset className="field" data-testid="codes">
        <legend>{t('pay.sform.field.codes')}</legend>
        {formsOf(settlement.scope).map((code) => (
          <label key={code}>
            <input type="checkbox" checked={form.codes.includes(code)} onChange={() => toggle(code)} /> {code}
            {code === DECISION_FORM ? <small className="sub"> {t('pay.sform.decision.note')}</small> : null}
          </label>
        ))}
        {sent && problems.codes !== undefined ? (
          <small role="alert" className="field-error">
            {formProblemLabel(t, problems.codes)}
          </small>
        ) : null}
      </fieldset>
      <Field id="sform-place" label={t('pay.sform.field.place')} error={sent && problems.place !== undefined ? formProblemLabel(t, problems.place) : undefined} hint={t('pay.sform.field.place.hint', { max: PLACE_MAX })}>
        <input id="sform-place" autoComplete="off" value={form.place} onChange={(event) => setForm({ ...form, place: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
