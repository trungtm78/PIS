import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { boqLink } from './boq-model';
import { BackLink, Field } from './components';
import { useExpiringGuarantees, useExtendGuarantee, useGuarantees, useRegisterGuarantee, useReleaseGuarantee, useVerifyGuarantee } from './guarantee-hooks';
import { alertLabel, formProblemMessage, kindLabel, problemMessage, statusLabel, verificationLabel, windowLabel } from './guarantee-labels';
import {
  EMPTY_EXTEND,
  EMPTY_FILTER,
  EMPTY_RELEASE,
  EMPTY_REGISTER,
  EMPTY_VERIFY,
  EXPIRING_WINDOWS,
  GUARANTEE_KINDS,
  GUARANTEE_MANAGE_PERMISSION,
  GUARANTEE_RELEASE_PERMISSION,
  GUARANTEE_STATUSES,
  GUARANTEE_VERIFY_PERMISSION,
  canExtend,
  canRelease,
  canVerify,
  daysLeftOf,
  describeProblem,
  extendBody,
  filterGuarantees,
  isOwnRegistration,
  registerBody,
  releaseBody,
  validateExtend,
  validateRegister,
  validateRelease,
  validateVerify,
  verifyBody,
} from './guarantee-model';
import type { ExtendForm, FormProblem, Guarantee, GuaranteeFilter, GuaranteeKind, GuaranteeStatus, RegisterForm, ReleaseForm, VerifyForm } from './guarantee-model';
import { useContract } from './hooks';
import { amountText, draftLink } from './model';
import type { ContractView } from './model';
import './ctr.css';

type Tab = 'all' | 'expiring';
type Action = { kind: 'verify' | 'extend' | 'release'; id: string };

const NEVER_EMPTY = (): boolean => false;

/** CTR-05: the guarantees and insurances of the contracts in scope, with their verification, expiry and reminders, and the commands to register, verify, extend and release them. */
export default function GuaranteeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the forms belong to one membership: a switch starts the screen over.
  return <GuaranteeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function GuaranteeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const contractId = params.get('id') ?? undefined;
  const [tab, setTab] = useState<Tab>('all');
  const guarantees = useGuarantees();
  const contract = useContract(contractId);
  const state = useScreenState({ isLoading: guarantees.isLoading, error: guarantees.error, data: guarantees.data, isEmpty: NEVER_EMPTY });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {contractId === undefined ? null : <BackLink to={draftLink(contractId)}>{t('ctr.back.draft.link')}</BackLink>}
      <div className="heading">
        <div>
          <h1 id="screen-title">{contract.data === undefined || contract.data === null ? t('ctr.guarantee.page.title') : `${contract.data.code} · ${t('ctr.guarantee.page.title')}`}</h1>
          <p>{t('ctr.guarantee.page.subtitle')}</p>
        </div>
        {contractId === undefined ? null : (
          <Link className="button" to={boqLink(contractId)}>
            {t('ctr.guarantee.boq.action')}
          </Link>
        )}
      </div>
      <div className="ctr-row-actions" role="group" aria-label={t('ctr.guarantee.tabs.label')}>
        <button type="button" className={tab === 'all' ? 'button primary' : 'button'} aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
          {t('ctr.guarantee.tab.all')}
        </button>
        <button type="button" className={tab === 'expiring' ? 'button primary' : 'button'} aria-pressed={tab === 'expiring'} onClick={() => setTab('expiring')}>
          {t('ctr.guarantee.tab.expiring')}
        </button>
      </div>
      {tab === 'all' ? (
        <StateBoundary state={state} onRetry={() => void guarantees.refetch()}>
          <RegisterBar contract={contract.data ?? undefined} contractId={contractId} />
          <GuaranteeList guarantees={guarantees.data ?? []} contractId={contractId} />
        </StateBoundary>
      ) : (
        <Expiring contractId={contractId} />
      )}
      <p className="prototype-note">{t('ctr.guarantee.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const can = (permissions: readonly string[] | undefined, permission: string, frozen: boolean): boolean => !frozen && (permissions === undefined || permissions.includes(permission));

// ---- the register form -------------------------------------------------------------------------------------------------------

function RegisterBar({ contract, contractId }: { contract: ContractView | undefined; contractId: string | undefined }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [open, setOpen] = useState(false);
  const allowed = contractId !== undefined && can(permissions, GUARANTEE_MANAGE_PERMISSION, mode === 'READ_ONLY');
  if (!allowed) return null;
  return open ? (
    <RegisterForm contractId={contractId} contract={contract} onDone={() => setOpen(false)} />
  ) : (
    <div className="ctr-row-actions">
      <button type="button" className="button primary" onClick={() => setOpen(true)}>
        {t('ctr.guarantee.register.open')}
      </button>
    </div>
  );
}

function RegisterForm({ contractId, contract, onDone }: { contractId: string; contract: ContractView | undefined; onDone: () => void }) {
  const { t } = useTranslation();
  const register = useRegisterGuarantee();
  const [form, setForm] = useState<RegisterForm>(EMPTY_REGISTER);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRegister(form);
  const problem = register.isError ? describeProblem(register.error) : undefined;
  const set = (patch: Partial<RegisterForm>): void => setForm((current) => ({ ...current, ...patch }));
  const error = (field: keyof RegisterForm): string | undefined => (submitted && problems[field] !== undefined ? formProblemMessage(t, problems[field] as FormProblem) : undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    register.mutate({ contractId, body: registerBody(form) }, { onSuccess: onDone });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('ctr.guarantee.register.title')}>
      <h2>{t('ctr.guarantee.register.title')}</h2>
      <ProblemNotice problem={problem} />
      <Field id="g-kind" label={t('ctr.guarantee.field.kind.label')} error={undefined}>
        <select id="g-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value as GuaranteeKind })}>
          {GUARANTEE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      {contract === undefined || contract.parties.length === 0 ? null : (
        <Field id="g-party" label={t('ctr.guarantee.field.party.label')} error={error('partyId')} hint={t('ctr.guarantee.field.party.hint')}>
          <select id="g-party" value={form.partyId} onChange={(event) => set({ partyId: event.target.value })}>
            <option value="">{t('ctr.guarantee.field.party.none')}</option>
            {contract.parties.map((party) => (
              <option key={party.id} value={party.id}>
                {party.contractorName ?? party.contractorId}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field id="g-issuer" label={t('ctr.guarantee.field.issuer.label')} error={error('issuer')}>
        <input id="g-issuer" value={form.issuer} onChange={(event) => set({ issuer: event.target.value })} />
      </Field>
      <Field id="g-number" label={t('ctr.guarantee.field.number.label')} error={error('guaranteeNo')}>
        <input id="g-number" value={form.guaranteeNo} onChange={(event) => set({ guaranteeNo: event.target.value })} />
      </Field>
      <Field id="g-amount" label={t('ctr.guarantee.field.amount.label')} error={error('amount')}>
        <input id="g-amount" inputMode="numeric" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field id="g-from" label={t('ctr.guarantee.field.validFrom.label')} error={error('validFrom')}>
        <input id="g-from" type="date" value={form.validFrom} onChange={(event) => set({ validFrom: event.target.value })} />
      </Field>
      <Field id="g-to" label={t('ctr.guarantee.field.expiresOn.label')} error={error('expiresOn')} hint={t('ctr.guarantee.field.expiresOn.hint')}>
        <input id="g-to" type="date" value={form.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} />
      </Field>
      <Field id="g-document" label={t('ctr.guarantee.field.document.label')} error={error('documentVersionId')}>
        <input id="g-document" value={form.documentVersionId} onChange={(event) => set({ documentVersionId: event.target.value })} />
      </Field>
      <div className="formfooter">
        <button type="button" className="button" onClick={onDone}>
          {t('ctr.guarantee.cancel.action')}
        </button>
        <button type="submit" className="button primary" disabled={register.isPending}>
          {register.isPending ? t('ctr.guarantee.register.pending') : t('ctr.guarantee.register.action')}
        </button>
      </div>
    </form>
  );
}

function ProblemNotice({ problem }: { problem: ReturnType<typeof describeProblem> | undefined }) {
  const { t, locale } = useTranslation();
  if (problem === undefined) return null;
  return (
    <p className="callout warning" role="alert" data-testid="problem">
      {problemMessage(t, problem, (amount) => amountText(amount, locale))}
    </p>
  );
}

// ---- the list ------------------------------------------------------------------------------------------------------------------

function GuaranteeList({ guarantees, contractId }: { guarantees: readonly Guarantee[]; contractId: string | undefined }) {
  const { t, locale } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [filter, setFilter] = useState<GuaranteeFilter>(EMPTY_FILTER);
  const [action, setAction] = useState<Action | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const now = useMemo(() => new Date(), []);
  const frozen = mode === 'READ_ONLY';
  const shown = filterGuarantees(guarantees, filter, contractId);
  const target = action === undefined ? undefined : guarantees.find((guarantee) => guarantee.id === action.id);
  const done = (message: string): void => {
    setAction(undefined);
    setNotice(message);
  };

  return (
    <>
      <div className="card">
        <form className="ctr-filters" role="search" aria-label={t('ctr.guarantee.filters.title')} onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="guarantee-query">{t('ctr.guarantee.query.label')}</label>
            <input id="guarantee-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="guarantee-status">{t('ctr.guarantee.status.label')}</label>
            <select id="guarantee-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as GuaranteeStatus | '' })}>
              <option value="">{t('ctr.guarantee.status.all')}</option>
              {GUARANTEE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="guarantee-kind">{t('ctr.guarantee.kind.label')}</label>
            <select id="guarantee-kind" value={filter.kind} onChange={(event) => setFilter({ ...filter, kind: event.target.value as GuaranteeKind | '' })}>
              <option value="">{t('ctr.guarantee.kind.all')}</option>
              {GUARANTEE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(t, kind)}
                </option>
              ))}
            </select>
          </div>
        </form>
        {notice === undefined ? null : (
          <p className="callout" role="status" data-testid="notice">
            {notice}
          </p>
        )}
        {shown.length === 0 ? (
          <p className="callout" role="status" data-testid="no-guarantees">
            {t('ctr.guarantee.list.empty')}
          </p>
        ) : (
          <table className="table" data-testid="guarantees">
            <thead>
              <tr>
                <th scope="col">{t('ctr.guarantee.column.kind')}</th>
                <th scope="col">{t('ctr.guarantee.column.issuer')}</th>
                <th scope="col">{t('ctr.guarantee.column.number')}</th>
                <th scope="col">{t('ctr.guarantee.column.amount')}</th>
                <th scope="col">{t('ctr.guarantee.column.expires')}</th>
                <th scope="col">{t('ctr.guarantee.column.alert')}</th>
                <th scope="col">{t('ctr.guarantee.column.member')}</th>
                <th scope="col">{t('ctr.guarantee.column.verification')}</th>
                <th scope="col">{t('ctr.guarantee.column.release')}</th>
                <th scope="col">
                  <span className="ctr-sr-only">{t('ctr.guarantee.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((guarantee) => (
                <tr key={guarantee.id} data-testid="guarantee-row">
                  <td>
                    {kindLabel(t, guarantee.kind)}
                    <br />
                    <span className="ctr-badge" data-testid="status">
                      {statusLabel(t, guarantee.status)}
                    </span>
                  </td>
                  <td>{guarantee.issuer}</td>
                  <td>{guarantee.guaranteeNo ?? ''}</td>
                  <td className="ctr-amount">{amountText(guarantee.amountVnd, locale)}</td>
                  <td>
                    {guarantee.expiresOn}
                    {guarantee.status === 'ACTIVE' ? (
                      <>
                        <br />
                        <span className="sub">{t('ctr.guarantee.expires.left', { days: daysLeftOf(guarantee, now) })}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{alertLabel(t, guarantee.lastAlertDays)}</td>
                  <td>{guarantee.partyName ?? ''}</td>
                  <td>{verificationLabel(t, guarantee.verificationStatus)}</td>
                  <td>{guarantee.status === 'RELEASED' ? (guarantee.releaseReason ?? t('ctr.guarantee.release.done')) : ''}</td>
                  <td>
                    <RowActions
                      guarantee={guarantee}
                      own={isOwnRegistration(guarantee, tenant?.membershipId)}
                      canVerifyNow={can(permissions, GUARANTEE_VERIFY_PERMISSION, frozen)}
                      canManageNow={can(permissions, GUARANTEE_MANAGE_PERMISSION, frozen)}
                      canReleaseNow={can(permissions, GUARANTEE_RELEASE_PERMISSION, frozen)}
                      onAction={(kind) => {
                        setNotice(undefined);
                        setAction({ kind, id: guarantee.id });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {action === undefined || target === undefined ? null : (
        // The panel is not keyed by the version: the command changes it, the read that follows must not unmount the panel before it reports that it succeeded.
        <ActionPanel key={`${action.kind}:${target.id}`} kind={action.kind} guarantee={target} onCancel={() => setAction(undefined)} onDone={done} />
      )}
    </>
  );
}

function RowActions({
  guarantee,
  own,
  canVerifyNow,
  canManageNow,
  canReleaseNow,
  onAction,
}: {
  guarantee: Guarantee;
  own: boolean;
  canVerifyNow: boolean;
  canManageNow: boolean;
  canReleaseNow: boolean;
  onAction: (kind: Action['kind']) => void;
}) {
  const { t } = useTranslation();
  const buttons: ReactNode[] = [];
  if (canVerify(guarantee) && canVerifyNow) {
    buttons.push(
      own ? (
        <span key="verify" className="sub" data-testid="own-registration">
          {t('ctr.guarantee.verify.own.hint')}
        </span>
      ) : (
        <button key="verify" type="button" className="button" onClick={() => onAction('verify')}>
          {t('ctr.guarantee.verify.action')}
        </button>
      ),
    );
  }
  if (canExtend(guarantee) && canManageNow) {
    buttons.push(
      <button key="extend" type="button" className="button" onClick={() => onAction('extend')}>
        {t('ctr.guarantee.extend.action')}
      </button>,
    );
  }
  if (canRelease(guarantee) && canReleaseNow && !own) {
    buttons.push(
      <button key="release" type="button" className="button" onClick={() => onAction('release')}>
        {t('ctr.guarantee.release.action')}
      </button>,
    );
  }
  return <div className="ctr-row-actions">{buttons}</div>;
}

// ---- the commands on one guarantee ----------------------------------------------------------------------------------------

function ActionPanel({ kind, guarantee, onCancel, onDone }: { kind: Action['kind']; guarantee: Guarantee; onCancel: () => void; onDone: (message: string) => void }) {
  switch (kind) {
    case 'verify':
      return <VerifyPanel guarantee={guarantee} onCancel={onCancel} onDone={onDone} />;
    case 'extend':
      return <ExtendPanel guarantee={guarantee} onCancel={onCancel} onDone={onDone} />;
    case 'release':
      return <ReleasePanel guarantee={guarantee} onCancel={onCancel} onDone={onDone} />;
  }
}

interface PanelProps {
  guarantee: Guarantee;
  onCancel: () => void;
  onDone: (message: string) => void;
}

function Panel({ title, guarantee, problem, pending, pendingLabel, submitLabel, onSubmit, onCancel, children }: PanelFrame) {
  const { t } = useTranslation();
  return (
    <form className="card" onSubmit={onSubmit} noValidate aria-label={title} data-testid="action-panel">
      <h2>{title}</h2>
      <p className="sub">{t('ctr.guarantee.panel.subject', { number: guarantee.guaranteeNo ?? guarantee.id, issuer: guarantee.issuer })}</p>
      <ProblemNotice problem={problem} />
      {children}
      <div className="formfooter">
        <button type="button" className="button" onClick={onCancel}>
          {t('ctr.guarantee.cancel.action')}
        </button>
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

interface PanelFrame {
  title: string;
  guarantee: Guarantee;
  problem: ReturnType<typeof describeProblem> | undefined;
  pending: boolean;
  pendingLabel: string;
  submitLabel: string;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  children: ReactNode;
}

function VerifyPanel({ guarantee, onCancel, onDone }: PanelProps) {
  const { t } = useTranslation();
  const verify = useVerifyGuarantee();
  const [form, setForm] = useState<VerifyForm>(EMPTY_VERIFY);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateVerify(form);
  const error = (field: keyof VerifyForm): string | undefined => (submitted && problems[field] !== undefined ? formProblemMessage(t, problems[field] as FormProblem) : undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (verify.isPending) return;
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    verify.mutate({ id: guarantee.id, version: guarantee.version, body: verifyBody(form) }, { onSuccess: () => onDone(form.outcome === 'VERIFIED' ? t('ctr.guarantee.verify.verified.notice') : t('ctr.guarantee.verify.failed.notice')) });
  };
  return (
    <Panel
      title={t('ctr.guarantee.verify.title')}
      guarantee={guarantee}
      problem={verify.isError ? describeProblem(verify.error) : undefined}
      pending={verify.isPending}
      pendingLabel={t('ctr.guarantee.verify.pending')}
      submitLabel={t('ctr.guarantee.verify.submit')}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <Field id="v-outcome" label={t('ctr.guarantee.field.outcome.label')} error={undefined}>
        <select id="v-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value as VerifyForm['outcome'] })}>
          <option value="VERIFIED">{t('ctr.guarantee.outcome.verified.label')}</option>
          <option value="FAILED">{t('ctr.guarantee.outcome.failed.label')}</option>
        </select>
      </Field>
      <Field id="v-method" label={t('ctr.guarantee.field.method.label')} error={error('method')} hint={t('ctr.guarantee.field.method.hint')}>
        <input id="v-method" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })} />
      </Field>
      <Field id="v-evidence" label={t('ctr.guarantee.field.evidence.label')} error={error('evidenceId')}>
        <input id="v-evidence" value={form.evidenceId} onChange={(event) => setForm({ ...form, evidenceId: event.target.value })} />
      </Field>
    </Panel>
  );
}

function ExtendPanel({ guarantee, onCancel, onDone }: PanelProps) {
  const { t } = useTranslation();
  const extend = useExtendGuarantee();
  const [form, setForm] = useState<ExtendForm>(EMPTY_EXTEND);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateExtend(form, guarantee.expiresOn);
  const error = (field: keyof ExtendForm): string | undefined => (submitted && problems[field] !== undefined ? formProblemMessage(t, problems[field] as FormProblem) : undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (extend.isPending) return;
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    extend.mutate({ id: guarantee.id, version: guarantee.version, body: extendBody(form) }, { onSuccess: () => onDone(t('ctr.guarantee.extend.done.notice')) });
  };
  return (
    <Panel
      title={t('ctr.guarantee.extend.title')}
      guarantee={guarantee}
      problem={extend.isError ? describeProblem(extend.error) : undefined}
      pending={extend.isPending}
      pendingLabel={t('ctr.guarantee.extend.pending')}
      submitLabel={t('ctr.guarantee.extend.submit')}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="sub">{t('ctr.guarantee.extend.rule')}</p>
      <Field id="x-date" label={t('ctr.guarantee.field.newExpiresOn.label')} error={error('expiresOn')} hint={t('ctr.guarantee.extend.current', { date: guarantee.expiresOn })}>
        <input id="x-date" type="date" value={form.expiresOn} onChange={(event) => setForm({ ...form, expiresOn: event.target.value })} />
      </Field>
      <Field id="x-number" label={t('ctr.guarantee.field.newNumber.label')} error={error('guaranteeNo')}>
        <input id="x-number" value={form.guaranteeNo} onChange={(event) => setForm({ ...form, guaranteeNo: event.target.value })} />
      </Field>
      <Field id="x-document" label={t('ctr.guarantee.field.document.label')} error={error('documentVersionId')}>
        <input id="x-document" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
    </Panel>
  );
}

function ReleasePanel({ guarantee, onCancel, onDone }: PanelProps) {
  const { t, locale } = useTranslation();
  const release = useReleaseGuarantee();
  const [form, setForm] = useState<ReleaseForm>(EMPTY_RELEASE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRelease(form);
  const error = (field: keyof ReleaseForm): string | undefined => (submitted && problems[field] !== undefined ? formProblemMessage(t, problems[field] as FormProblem) : undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (release.isPending) return;
    setSubmitted(true);
    if (Object.keys(problems).length > 0) return;
    release.mutate({ id: guarantee.id, version: guarantee.version, body: releaseBody(form) }, { onSuccess: () => onDone(t('ctr.guarantee.release.done.notice')) });
  };
  const owed = guarantee.kind === 'ADVANCE' ? guarantee.advanceOutstandingVnd : undefined;
  return (
    <Panel
      title={t('ctr.guarantee.release.title')}
      guarantee={guarantee}
      problem={release.isError ? describeProblem(release.error) : undefined}
      pending={release.isPending}
      pendingLabel={t('ctr.guarantee.release.pending')}
      submitLabel={t('ctr.guarantee.release.submit')}
      onSubmit={submit}
      onCancel={onCancel}
    >
      {owed === undefined || owed === '0' ? null : (
        <p className="callout warning" data-testid="advance-owed">
          {t('ctr.guarantee.release.owed', { amount: amountText(owed, locale) })}
        </p>
      )}
      <Field id="r-evidence" label={t('ctr.guarantee.field.releaseEvidence.label')} error={error('evidenceId')}>
        <input id="r-evidence" value={form.evidenceId} onChange={(event) => setForm({ ...form, evidenceId: event.target.value })} />
      </Field>
      <Field id="r-reason" label={t('ctr.guarantee.field.reason.label')} error={error('reason')}>
        <input id="r-reason" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
    </Panel>
  );
}

// ---- the guarantees about to expire --------------------------------------------------------------------------------------

function Expiring({ contractId }: { contractId: string | undefined }) {
  const { t, locale } = useTranslation();
  const [days, setDays] = useState<number>(EXPIRING_WINDOWS[0]);
  const expiring = useExpiringGuarantees(days);
  const state = useScreenState({ isLoading: expiring.isLoading, error: expiring.error, data: expiring.data, isEmpty: NEVER_EMPTY });
  const rows = (expiring.data ?? []).filter((guarantee) => contractId === undefined || guarantee.contractId === contractId);
  return (
    <StateBoundary state={state} onRetry={() => void expiring.refetch()}>
      <div className="card">
        <div className="field">
          <label htmlFor="expiring-window">{t('ctr.guarantee.window.label')}</label>
          <select id="expiring-window" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {EXPIRING_WINDOWS.map((window) => (
              <option key={window} value={window}>
                {windowLabel(t, window)}
              </option>
            ))}
          </select>
        </div>
        {rows.length === 0 ? (
          <p className="callout" role="status" data-testid="none-expiring">
            {t('ctr.guarantee.expiring.empty')}
          </p>
        ) : (
          <table className="table" data-testid="expiring">
            <thead>
              <tr>
                <th scope="col">{t('ctr.guarantee.column.kind')}</th>
                <th scope="col">{t('ctr.guarantee.column.contract')}</th>
                <th scope="col">{t('ctr.guarantee.column.issuer')}</th>
                <th scope="col">{t('ctr.guarantee.column.amount')}</th>
                <th scope="col">{t('ctr.guarantee.column.expires')}</th>
                <th scope="col">{t('ctr.guarantee.column.daysLeft')}</th>
                <th scope="col">{t('ctr.guarantee.column.advanceOwed')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((guarantee) => (
                <tr key={guarantee.id} data-testid="expiring-row">
                  <td>{kindLabel(t, guarantee.kind)}</td>
                  <td>{guarantee.contractCode}</td>
                  <td>{guarantee.issuer}</td>
                  <td className="ctr-amount">{amountText(guarantee.amountVnd, locale)}</td>
                  <td>{guarantee.expiresOn}</td>
                  <td>{guarantee.daysLeft ?? ''}</td>
                  <td className="ctr-amount">{guarantee.advanceOutstandingVnd === undefined ? '' : amountText(guarantee.advanceOutstandingVnd, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </StateBoundary>
  );
}
