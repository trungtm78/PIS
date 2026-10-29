import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useUnits } from '../members/hooks';
import { businessToday } from '../org-tree/business-date';
import { useDecide, useHeadcount, usePropose, useReorganization, useReorganizations } from './hooks';
import { decisionLabel, formProblemMessage, kindLabel, problemMessage, statusLabel, statusTone, stepLabel, wizardStepLabel } from './labels';
import { APPROVE_PERMISSION, KINDS, PROPOSE_PERMISSION, READ_PERMISSION, REASON_MIN, UNIT_TYPES, WIZARD_STEPS, decisionsFor, describeProblem, emptyForm, formProblems, problemsOfStep, readMissing, stepCounts, toBody } from './model';
import type { Form, FormProblem, ReorganizationView, WizardStep } from './model';
import './reorganization.css';

/**
 * ADM-16: the reorganisation of organisation units (ST-ADM-015, ADM 3.2). A wizard of four steps proposes a merge, split, dissolution or rename (what changes, where things go, what it will do, the submission); the list is the saga
 * seen from outside: the state of each proposal and, for the one opened, a timeline of what has been done (successors, members, grants, projects, old units). Another person approves; the job carries it out on its date; a saga that
 * stopped on a step is decided again once the cause is mended.
 */
export default function ReorganizationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ReorganizationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReorganizationContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [wizard, setWizard] = useState(false);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [deciding, setDeciding] = useState<ReorganizationView | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const mayPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  const list = useReorganizations(mayRead);
  const detail = useReorganization(opened);
  const queryState = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const state = mayRead ? queryState : 'denied';
  const rows = list.data ?? [];
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(`${iso}T00:00:00+07:00`));
  const names = (units: ReorganizationView['predecessors'], fresh: string | null): string => [...units.map((unit) => unit.name), ...(fresh === null ? [] : [fresh])].join(', ');

  return (
    <section className="adm-reorg" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.reorg.title')}</h1>
          <p>{t('adm.reorg.subtitle')}</p>
        </div>
        {mayPropose ? (
          <button type="button" className="primary" data-action="new" onClick={() => setWizard(true)}>
            {t('adm.reorg.new.action')}
          </button>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          <table className="table" data-testid="reorganizations">
            <thead>
              <tr>
                <th scope="col">{t('adm.reorg.column.kind')}</th>
                <th scope="col">{t('adm.reorg.column.from')}</th>
                <th scope="col">{t('adm.reorg.column.to')}</th>
                <th scope="col">{t('adm.reorg.column.date')}</th>
                <th scope="col">{t('adm.reorg.column.basis')}</th>
                <th scope="col">{t('adm.reorg.column.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('adm.reorg.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-reorganization={row.id} data-status={row.status} data-selected={row.id === opened ? 'yes' : 'no'}>
                  <td>{kindLabel(t, row.kind)}</td>
                  <td>{names(row.predecessors, null)}</td>
                  <td>{names(row.successors, row.newUnitName)}</td>
                  <td>{moment(row.effectiveFrom)}</td>
                  <td>{row.legalBasisRef}</td>
                  <td>
                    <span className={`pill ${statusTone(row.status)}`} data-testid="status">
                      {statusLabel(t, row.status)}
                    </span>
                  </td>
                  <td>
                    <button type="button" data-action="open" onClick={() => setOpened(row.id)}>
                      {t('adm.reorg.open.action')}
                    </button>{' '}
                    {row.mayDecide && permissions?.includes(APPROVE_PERMISSION) !== false && mode !== 'READ_ONLY' ? (
                      <button type="button" className="primary" data-action="decide" onClick={() => setDeciding(row)}>
                        {t('adm.reorg.decide.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {opened === undefined ? null : <Timeline view={detail.data} loading={detail.isLoading} failed={detail.isError} />}
      </StateBoundary>
      {wizard ? <Wizard onClose={() => setWizard(false)} /> : null}
      {deciding === undefined ? null : <DecideDialog reorganization={deciding} onClose={() => setDeciding(undefined)} />}
    </section>
  );
}

function Timeline({ view, loading, failed }: { view: ReorganizationView | undefined; loading: boolean; failed: boolean }) {
  const { t } = useTranslation();
  if (loading) return <p className="sub">{t('adm.reorg.timeline.loading')}</p>;
  if (failed || view === undefined)
    return (
      <p className="callout warning" role="alert">
        {t('adm.reorg.error.notFound')}
      </p>
    );
  const counts = stepCounts(view.steps);
  return (
    <div className="card" data-testid="timeline" data-for={view.id}>
      <h2>{t('adm.reorg.timeline.title')}</h2>
      <p className="sub">{t('adm.reorg.timeline.people', { proposer: view.requestedByName === '' ? t('adm.reorg.none') : view.requestedByName, approver: view.approvedByName === '' ? t('adm.reorg.none') : view.approvedByName })}</p>
      {view.decisionReason === null ? null : <p className="sub">{view.decisionReason}</p>}
      {counts.length === 0 ? (
        <p className="sub" data-testid="no-steps">
          {t('adm.reorg.timeline.none')}
        </p>
      ) : (
        <ol className="reorg-steps">
          {counts.map((entry) => (
            <li key={entry.kind} data-step={entry.kind}>
              {stepLabel(t, entry.kind, entry.count)}
            </li>
          ))}
        </ol>
      )}
      {view.status === 'Failed' ? (
        <p className="callout warning" role="alert" data-testid="failed">
          {t('adm.reorg.timeline.failed', { step: view.failedStep ?? '', code: view.failedCode ?? '' })}
        </p>
      ) : null}
      {view.status === 'Applied' ? (
        <p className="sub" data-testid="applied">
          {t('adm.reorg.timeline.applied', { members: Number(view.summary?.memberships ?? 0), grants: Number(view.summary?.grants ?? 0), projects: Number(view.summary?.projects ?? 0) })}
        </p>
      ) : null}
    </div>
  );
}

function Wizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const propose = usePropose();
  const units = useUnits(true);
  const headcount = useHeadcount(true);
  // The date of the day is the Vietnam date, which the saga judges by: not the UTC date of the browser.
  const [today] = useState(() => businessToday());
  const [form, setForm] = useState<Form>(() => emptyForm(today));
  const [step, setStep] = useState<WizardStep>('choose');
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Form>): void => setForm({ ...form, ...patch });
  const at = WIZARD_STEPS.indexOf(step);
  const problems = tried ? problemsOfStep(form, step) : [];
  const has = (problem: FormProblem): string | undefined => (problems.includes(problem) ? formProblemMessage(t, problem) : undefined);
  const options = units.data ?? [];
  const nameOf = (id: string): string => options.find((unit) => unit.id === id)?.name ?? id.slice(0, 8);
  const moving = form.predecessorIds.reduce((sum, id) => sum + (headcount.data?.get(id) ?? 0), 0);
  const missing = propose.isError ? readMissing(propose.error) : { members: [], projects: [] };
  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  const next = (event: FormEvent): void => {
    event.preventDefault();
    if (step === 'submit') {
      if (propose.isPending || formProblems(form).length > 0) return;
      propose.mutate(toBody(form), { onSuccess: onClose });
      return;
    }
    setTried(true);
    if (problemsOfStep(form, step).length > 0) return;
    setTried(false);
    setStep(WIZARD_STEPS[at + 1] as WizardStep);
  };
  return (
    <CommandFrame
      title={t('adm.reorg.wizard.title')}
      refusal={propose.isError ? problemMessage(t, describeProblem(propose.error)) : undefined}
      pending={propose.isPending}
      submitLabel={step === 'submit' ? t('adm.reorg.wizard.submit') : t('adm.reorg.wizard.next')}
      words={{ close: t('adm.reorg.dialog.close'), cancel: t('adm.reorg.dialog.cancel'), pending: t('adm.reorg.dialog.pending') }}
      onSubmit={next}
      onClose={onClose}
    >
      <ol className="reorg-wizard" aria-label={t('adm.reorg.wizard.steps')}>
        {WIZARD_STEPS.map((entry, index) => (
          <li key={entry} data-wizard-step={entry} aria-current={entry === step ? 'step' : undefined}>
            {index + 1}. {wizardStepLabel(t, entry)}
          </li>
        ))}
      </ol>
      {missing.members.length + missing.projects.length === 0 ? null : (
        <p className="callout warning" role="alert" data-testid="missing">
          {t('adm.reorg.missing', { members: missing.members.length, projects: missing.projects.length })}
        </p>
      )}
      <fieldset disabled={propose.isPending}>
        {step === 'choose' ? (
          <>
            <Field id="reorg-kind" label={t('adm.reorg.form.kind')} error={undefined}>
              <select id="reorg-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value as Form['kind'], successorIds: [], newUnit: undefined, defaultSuccessorId: '' })}>
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel(t, kind)}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset>
              <legend>{t('adm.reorg.form.predecessors')}</legend>
              {options.map((unit) => (
                <label key={unit.id} className="reorg-unit">
                  <input type="checkbox" data-role="predecessor" value={unit.id} checked={form.predecessorIds.includes(unit.id)} onChange={() => set({ predecessorIds: toggle(form.predecessorIds, unit.id) })} /> {unit.name}
                </label>
              ))}
              {['predecessorsRequired', 'mergeNeedsTwo', 'onePredecessor'].map((problem) =>
                has(problem as FormProblem) === undefined ? null : (
                  <p key={problem} className="field-error">
                    {has(problem as FormProblem)}
                  </p>
                ),
              )}
            </fieldset>
            <fieldset>
              <legend>{t('adm.reorg.form.successors')}</legend>
              {options
                .filter((unit) => !form.predecessorIds.includes(unit.id))
                .map((unit) => (
                  <label key={unit.id} className="reorg-unit">
                    <input type="checkbox" data-role="successor" value={unit.id} checked={form.successorIds.includes(unit.id)} onChange={() => set({ successorIds: toggle(form.successorIds, unit.id) })} /> {unit.name}
                  </label>
                ))}
              {form.kind !== 'SPLIT' && form.successorIds.length === 0 ? (
                <label className="reorg-unit">
                  <input type="checkbox" data-role="new-unit" checked={form.newUnit !== undefined} onChange={(event) => set({ newUnit: event.target.checked ? { code: '', name: '', parentId: '', unitType: 'DEPARTMENT' } : undefined })} /> {t('adm.reorg.form.newUnit')}
                </label>
              ) : null}
              {['successorRequired', 'oneSuccessor', 'splitNeedsTwo', 'successorIsPredecessor'].map((problem) =>
                has(problem as FormProblem) === undefined ? null : (
                  <p key={problem} className="field-error">
                    {has(problem as FormProblem)}
                  </p>
                ),
              )}
            </fieldset>
            {form.newUnit === undefined ? null : (
              <fieldset>
                <Field id="reorg-new-code" label={t('adm.reorg.form.newUnit.code')} error={undefined}>
                  <input id="reorg-new-code" value={form.newUnit.code} onChange={(event) => set({ newUnit: { ...(form.newUnit as NonNullable<Form['newUnit']>), code: event.target.value } })} />
                </Field>
                <Field id="reorg-new-name" label={t('adm.reorg.form.newUnit.name')} error={undefined}>
                  <input id="reorg-new-name" value={form.newUnit.name} onChange={(event) => set({ newUnit: { ...(form.newUnit as NonNullable<Form['newUnit']>), name: event.target.value } })} />
                </Field>
                <Field id="reorg-new-parent" label={t('adm.reorg.form.newUnit.parent')} error={has('newUnitIncomplete')}>
                  <select id="reorg-new-parent" value={form.newUnit.parentId} onChange={(event) => set({ newUnit: { ...(form.newUnit as NonNullable<Form['newUnit']>), parentId: event.target.value } })}>
                    <option value="">{t('adm.reorg.form.choose')}</option>
                    {options.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="reorg-new-type" label={t('adm.reorg.form.newUnit.type')} error={undefined}>
                  <select id="reorg-new-type" value={form.newUnit.unitType} onChange={(event) => set({ newUnit: { ...(form.newUnit as NonNullable<Form['newUnit']>), unitType: event.target.value } })}>
                    {UNIT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </Field>
              </fieldset>
            )}
            <Field id="reorg-date" label={t('adm.reorg.form.date')} error={has('dateInvalid')}>
              <input id="reorg-date" type="date" value={form.effectiveFrom} onChange={(event) => set({ effectiveFrom: event.target.value })} />
            </Field>
            <Field id="reorg-basis" label={t('adm.reorg.form.basis')} error={has('basisShort')}>
              <input id="reorg-basis" value={form.legalBasis} onChange={(event) => set({ legalBasis: event.target.value })} />
            </Field>
          </>
        ) : null}
        {step === 'map' ? (
          <>
            <p>{form.successorIds.length + (form.newUnit === undefined ? 0 : 1) <= 1 ? t('adm.reorg.map.sole') : t('adm.reorg.map.several')}</p>
            {form.kind === 'SPLIT' ? (
              <Field id="reorg-default" label={t('adm.reorg.form.default')} error={has('defaultRequired')}>
                <select id="reorg-default" value={form.defaultSuccessorId} onChange={(event) => set({ defaultSuccessorId: event.target.value })}>
                  <option value="">{t('adm.reorg.form.choose')}</option>
                  {form.successorIds.map((id) => (
                    <option key={id} value={id}>
                      {nameOf(id)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </>
        ) : null}
        {step === 'preview' || step === 'submit' ? (
          <div data-testid="preview">
            <dl className="reorg-preview">
              <dt>{t('adm.reorg.form.kind')}</dt>
              <dd>{kindLabel(t, form.kind)}</dd>
              <dt>{t('adm.reorg.column.from')}</dt>
              <dd>{form.predecessorIds.map(nameOf).join(', ')}</dd>
              <dt>{t('adm.reorg.column.to')}</dt>
              <dd>{[...form.successorIds.map(nameOf), ...(form.newUnit === undefined ? [] : [form.newUnit.name])].join(', ')}</dd>
              <dt>{t('adm.reorg.form.date')}</dt>
              <dd>{form.effectiveFrom}</dd>
              <dt>{t('adm.reorg.form.basis')}</dt>
              <dd>{form.legalBasis}</dd>
            </dl>
            <p data-testid="impact">{t('adm.reorg.preview.members', { count: moving })}</p>
            <p className="sub">{t('adm.reorg.preview.note')}</p>
          </div>
        ) : null}
      </fieldset>
      {at === 0 ? null : (
        <button type="button" data-action="back" onClick={() => setStep(WIZARD_STEPS[at - 1] as WizardStep)}>
          {t('adm.reorg.wizard.back')}
        </button>
      )}
    </CommandFrame>
  );
}

function DecideDialog({ reorganization, onClose }: { reorganization: ReorganizationView; onClose: () => void }) {
  const { t } = useTranslation();
  const decide = useDecide();
  const { tenant: signedIn } = useSession();
  const [decision, setDecision] = useState<'approve' | 'return' | 'reject'>(() => decisionsFor(reorganization, signedIn?.membershipId)[0] ?? 'approve');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const tooShort = reason.trim().length < REASON_MIN;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || tooShort) return;
    decide.mutate({ id: reorganization.id, version: reorganization.version, decision, reason: reason.trim() }, { onSuccess: onClose });
  };
  const { tenant } = useSession();
  const decisions = decisionsFor(reorganization, tenant?.membershipId);
  return (
    <CommandFrame
      title={t('adm.reorg.decide.title')}
      refusal={decide.isError ? problemMessage(t, describeProblem(decide.error)) : undefined}
      pending={decide.isPending}
      submitLabel={t('adm.reorg.decide.submit')}
      words={{ close: t('adm.reorg.dialog.close'), cancel: t('adm.reorg.dialog.cancel'), pending: t('adm.reorg.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={decide.isPending}>
        <p>{reorganization.status === 'Failed' ? t('adm.reorg.decide.again') : t('adm.reorg.decide.text')}</p>
        <Field id="reorg-decision" label={t('adm.reorg.decide.decision')} error={undefined}>
          <select id="reorg-decision" value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
            {decisions.map((entry) => (
              <option key={entry} value={entry}>
                {decisionLabel(t, entry)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="reorg-reason" label={t('adm.reorg.decide.reason')} error={submitted && tooShort ? t('adm.reorg.problem.reason') : undefined}>
          <textarea id="reorg-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
