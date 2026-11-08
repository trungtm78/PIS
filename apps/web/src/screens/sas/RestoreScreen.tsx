import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { ReleaseFlagNote } from '../../session/ReleaseFlagNote';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useAskRestore, useDecideRestore, useTenantRestores } from './restore/hooks';
import { failureLabel, problemMessage, statusLabel, statusTone, targetLabel, tenantStatusLabel } from './restore/labels';
import {
  MANAGE_PERMISSION,
  MAX_REASON,
  READ_PERMISSION,
  canAskInPlace,
  canAskRestore,
  canDecide,
  clock,
  describeProblem,
  isInsideWindow,
  isReasonValid,
  toInstant,
} from './restore/model';
import type { RestoreTarget, RestoreView } from './restore/model';
import { ReportPanel } from './restore/ReportPanel';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { toneClass } from './tenants/labels';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './billing/billing.css';
import { toneOfPill } from '../adm/kit-tone';

type Field = 'point' | 'reason';
interface Deciding {
  restoreId: string;
  decision: 'approve' | 'reject';
}

/**
 * SAS-21: the restore of one tenant to a recovery point (NFR-AVAILABILITY-02 and 03, SAS.md 3.11). A System Admin asks for a copy in a sandbox (the default), or over the data of the tenant while it is Suspended, naming the recovery
 * point (UTC) and why; a second System Admin approves or turns it down, never the one who asked. The worker makes the restore and measures the copy against the backup, and the screen shows the verification report: rows, checksum and
 * money totals of every table, any row of another tenant, and the RPO and RTO against their targets. Where no restore engine is bound there is no window of recovery points and nothing can be asked for. Reopening a tenant after an
 * in-place restore is the System Admin's own decision (`resumeTenant`), not something this screen does.
 */
export default function RestoreScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  if (permissions?.includes(MANAGE_PERMISSION) !== true && permissions?.includes(READ_PERMISSION) !== true) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
        <div className="heading">
          <div>
            <h1 id="screen-title">{t('sas.restore.page.title')}</h1>
          </div>
        </div>
        <StateBoundary state="denied" />
      </section>
    );
  }
  // The forms and the notices belong to one membership: a switch starts the screen over.
  return <RestoreContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RestoreContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions } = useSession();
  const canManage = permissions?.includes(MANAGE_PERMISSION) === true;
  const choice = useTenantChoice();
  const restores = useTenantRestores(choice.chosen, true);
  const ask = useAskRestore();
  const decide = useDecideRestore();
  // The forms belong to the tenant they were opened for: choosing another tenant leaves them behind, so a request prepared for one never reaches another.
  const [point, setPoint] = useState('');
  const [target, setTarget] = useState<RestoreTarget>('SANDBOX');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<ReadonlySet<Field>>(new Set());
  const [asked, setAsked] = useState<{ tenantId: string | undefined } | undefined>(undefined);
  const [deciding, setDeciding] = useState<(Deciding & { tenantId: string | undefined }) | undefined>(undefined);
  const [decisionReason, setDecisionReason] = useState('');
  const [decisionInvalid, setDecisionInvalid] = useState(false);
  const [decided, setDecided] = useState<{ tenantId: string | undefined; decision: 'approve' | 'reject' } | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(undefined);

  const pick = (tenantId: string): void => {
    ask.reset();
    decide.reset();
    setAsked(undefined);
    setDeciding(undefined);
    setDecided(undefined);
    setOpened(undefined);
    setInvalid(new Set());
    setPoint('');
    setReason('');
    setTarget('SANDBOX');
    setDecisionReason('');
    choice.choose(tenantId);
  };

  const state = useScreenState({ isLoading: choice.isLoading || restores.isLoading, error: choice.error ?? restores.error, data: restores.data, isEmpty: () => false });
  const page = restores.data?.pages[0];
  const items = (restores.data?.pages ?? []).flatMap((entry) => entry?.items ?? []);
  const problem = ask.isError ? describeProblem(ask.error) : decide.isError ? describeProblem(decide.error) : undefined;
  const day = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const acting = deciding?.tenantId === choice.chosen ? deciding : undefined;
  const sent = asked?.tenantId === choice.chosen;
  const done = decided !== undefined && decided.tenantId === choice.chosen ? decided.decision : undefined;
  const busy = ask.isPending || decide.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !canManage || choice.chosen === undefined || page === undefined || !canAskRestore(page.tenantStatus)) return;
    const instant = toInstant(point);
    const bad = new Set<Field>();
    if (instant === undefined || !isInsideWindow(instant, page.window)) bad.add('point');
    if (!isReasonValid(reason)) bad.add('reason');
    if (bad.size > 0 || instant === undefined) {
      setInvalid(bad);
      return;
    }
    setAsked(undefined);
    setDecided(undefined);
    const tenantId = choice.chosen;
    ask.mutate(
      { tenantId, recoveryPoint: instant, target: target === 'IN_PLACE' && !canAskInPlace(page.tenantStatus) ? 'SANDBOX' : target, reason: reason.trim() },
      {
        onSuccess: () => {
          setAsked({ tenantId });
          setInvalid(new Set());
          setPoint('');
          setReason('');
          setTarget('SANDBOX');
        },
      },
    );
  };

  const open = (entry: RestoreView, decision: 'approve' | 'reject'): void => {
    ask.reset();
    decide.reset();
    setDecided(undefined);
    setDecisionInvalid(false);
    setDecisionReason('');
    setDeciding({ restoreId: entry.id, decision, tenantId: choice.chosen });
  };

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    const entry = items.find((candidate) => candidate.id === acting?.restoreId);
    if (acting === undefined || entry === undefined || choice.chosen === undefined || busy) return;
    if (!isReasonValid(decisionReason)) {
      setDecisionInvalid(true);
      return;
    }
    const tenantId = choice.chosen;
    decide.mutate(
      { tenantId, restoreId: entry.id, version: entry.version, decision: acting.decision, reason: decisionReason.trim() },
      {
        onSuccess: () => {
          setDecided({ tenantId, decision: acting.decision });
          setDeciding(undefined);
          setDecisionReason('');
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.restore.page.title')}</h1>
          <p>{t('sas.restore.page.subtitle')}</p>
        </div>
      </div>
      <ReleaseFlagNote flagKey="sas.tenant_restore_in_place" />
      <TenantPicker id="restore-tenant" label={t('sas.restore.tenant.label')} moreLabel={t('sas.restore.tenant.more.action')} choice={{ ...choice, choose: pick }} />
      <StateBoundary state={state} onRetry={() => {
          choice.refetch();
          void restores.refetch();
        }}>
        {page === undefined ? null : (
          <>
            <SectionCard title={t('sas.restore.window.title')}>
              <div data-recovery>
              <dl className="kv">
                <dt>{t('sas.restore.window.tenant')}</dt>
                <dd data-tenant-status>{tenantStatusLabel(t, page.tenantStatus)}</dd>
                <dt>{t('sas.restore.window.points')}</dt>
                <dd data-window>{page.window === undefined ? t('sas.restore.window.none') : t('sas.restore.window.range', { from: day(page.window.earliest), to: day(page.window.latest) })}</dd>
                <dt>{t('sas.restore.window.scope')}</dt>
                <dd>{t('sas.restore.window.scopeValue')}</dd>
                <dt>{t('sas.restore.window.targets')}</dt>
                <dd data-targets>{t('sas.restore.window.targetsValue', { rpo: clock(page.rpoTargetSeconds), rto: clock(page.rtoTargetSeconds) })}</dd>
              </dl>
              {page.window === undefined ? (
                <p className="callout warning" role="status" data-no-engine>
                  {t('sas.restore.window.noneRule')}
                </p>
              ) : null}
              </div>
            </SectionCard>
            {done === undefined ? null : (
              <p className="callout" role="status">
                {done === 'approve' ? t('sas.restore.done.approved') : t('sas.restore.done.rejected')}
              </p>
            )}
            {problem === undefined ? null : (
              <div className="callout warning" role="alert">
                <p>{problemMessage(t, problem)}</p>
              </div>
            )}
            {canManage ? (
              <SectionCard title={t('sas.restore.ask.title')}>
                <p className="sub">{t('sas.restore.ask.rule')}</p>
                {sent ? (
                  <p className="callout" role="status">
                    {t('sas.restore.done.asked')}
                  </p>
                ) : null}
                <form onSubmit={submit} noValidate aria-label={t('sas.restore.ask.aria')} className="billing-issue">
                  <div className="field">
                    <label htmlFor="restore-point">{t('sas.restore.ask.point.label')}</label>
                    <input id="restore-point" type="datetime-local" value={point} aria-invalid={invalid.has('point')} readOnly={ask.isPending} onChange={(event) => setPoint(event.target.value)} />
                    <small className="sub">{t('sas.restore.ask.point.hint')}</small>
                    {invalid.has('point') ? (
                      <small role="alert" className="field-error">
                        {page.window === undefined ? t('sas.restore.ask.point.none') : t('sas.restore.ask.point.invalid')}
                      </small>
                    ) : null}
                  </div>
                  <fieldset className="field">
                    <legend>{t('sas.restore.ask.target.legend')}</legend>
                    <label>
                      <input type="radio" name="restore-target" checked={target === 'SANDBOX'} onChange={() => setTarget('SANDBOX')} /> {t('sas.restore.target.sandbox')}
                    </label>{' '}
                    <label>
                      <input type="radio" name="restore-target" checked={target === 'IN_PLACE' && canAskInPlace(page.tenantStatus)} disabled={!canAskInPlace(page.tenantStatus)} onChange={() => setTarget('IN_PLACE')} />{' '}
                      {t('sas.restore.target.inPlace')}
                    </label>
                    {canAskInPlace(page.tenantStatus) ? null : <small className="sub">{t('sas.restore.ask.target.inPlaceRule')}</small>}
                  </fieldset>
                  <div className="field">
                    <label htmlFor="restore-reason">{t('sas.restore.ask.reason.label')}</label>
                    <textarea id="restore-reason" rows={2} maxLength={MAX_REASON} value={reason} aria-invalid={invalid.has('reason')} readOnly={ask.isPending} onChange={(event) => setReason(event.target.value)} />
                    {invalid.has('reason') ? (
                      <small role="alert" className="field-error">
                        {t('sas.restore.ask.reason.tooShort')}
                      </small>
                    ) : null}
                  </div>
                  <div className="row gap">
                    <button type="submit" className="ui-button ui-button--primary" disabled={busy || page.window === undefined || !canAskRestore(page.tenantStatus)}>
                      {t('sas.restore.ask.submit.action')}
                    </button>
                    {canAskRestore(page.tenantStatus) ? null : <span className="sub">{t('sas.restore.ask.stateRule')}</span>}
                  </div>
                </form>
              </SectionCard>
            ) : null}
            <SectionCard title={t('sas.restore.list.title')}>
              {items.length === 0 ? (
                <p className="sub" role="status">
                  {t('sas.restore.list.none')}
                </p>
              ) : (
                <KitTable caption={t('w2sas.restore.table.caption')} data-restores>
                  <thead>
                    <tr>
                      <th scope="col">{t('sas.restore.column.point')}</th>
                      <th scope="col">{t('sas.restore.column.target')}</th>
                      <th scope="col">{t('sas.restore.column.status')}</th>
                      <th scope="col">{t('sas.restore.column.requested')}</th>
                      <th scope="col">{t('sas.restore.column.approver')}</th>
                      <th scope="col">{t('sas.restore.column.sandbox')}</th>
                      <th scope="col">
                        <span className="visually-hidden">{t('sas.restore.column.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((entry) => (
                      <tr key={entry.id} data-restore-id={entry.id} data-status={entry.status} data-target={entry.target}>
                        <td>{day(entry.recoveryPoint)}</td>
                        <td>{targetLabel(t, entry.target)}</td>
                        <td>
                          <StatusPill tone={toneOfPill(toneClass(statusTone(entry.status)))}>{statusLabel(t, entry.status)}</StatusPill>
                          {entry.errorCode === undefined ? null : (
                            <small className="sub" data-failure>
                              {' · '}
                              {failureLabel(t, entry.errorCode)}
                            </small>
                          )}
                        </td>
                        <td>
                          {day(entry.requestedAt)}
                          <br />
                          <small className="sub">{entry.reason}</small>
                        </td>
                        <td data-approver>
                          {entry.approvedBy !== undefined ? (
                            <>
                              <code>{entry.approvedBy.slice(0, 8)}</code>
                              {entry.decidedAt === undefined ? null : <small className="sub"> · {day(entry.decidedAt)}</small>}
                            </>
                          ) : entry.status === 'Requested' ? (
                            <small className="sub" data-waiting>
                              {entry.requestedBy.toLowerCase() === tenant?.membershipId.toLowerCase() ? t('sas.restore.approver.other') : t('sas.restore.approver.waiting')}
                            </small>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{entry.sandboxRef === undefined ? '—' : <code>{entry.sandboxRef}</code>}</td>
                        <td>
                          <div className="row gap">
                            {canDecide(entry, tenant?.membershipId, canManage) ? (
                              <>
                                <button type="button" disabled={busy} onClick={() => open(entry, 'approve')}>
                                  {t('sas.restore.approve.action')}
                                </button>
                                <button type="button" disabled={busy} onClick={() => open(entry, 'reject')}>
                                  {t('sas.restore.reject.action')}
                                </button>
                              </>
                            ) : null}
                            {entry.report === undefined ? null : (
                              <button type="button" aria-expanded={opened === entry.id} onClick={() => setOpened(opened === entry.id ? undefined : entry.id)}>
                                {opened === entry.id ? t('sas.restore.report.hide.action') : t('sas.restore.report.show.action')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
              )}
              {restores.hasNextPage ? (
                <div className="row gap">
                  <button type="button" disabled={restores.isFetchingNextPage} onClick={() => void restores.fetchNextPage()}>
                    {t('sas.restore.list.more.action')}
                  </button>
                </div>
              ) : null}
              {acting === undefined ? null : (
                <form onSubmit={confirm} noValidate aria-label={t('sas.restore.decide.aria')} className="billing-issue">
                  <p className="callout">{acting.decision === 'approve' ? t('sas.restore.decide.approveRule') : t('sas.restore.decide.rejectRule')}</p>
                  <div className="field">
                    <label htmlFor="restore-decision-reason">{t('sas.restore.decide.reason.label')}</label>
                    <textarea
                      id="restore-decision-reason"
                      rows={2}
                      maxLength={MAX_REASON}
                      value={decisionReason}
                      aria-invalid={decisionInvalid}
                      readOnly={decide.isPending}
                      onChange={(event) => setDecisionReason(event.target.value)}
                    />
                    {decisionInvalid ? (
                      <small role="alert" className="field-error">
                        {t('sas.restore.decide.reason.tooShort')}
                      </small>
                    ) : null}
                  </div>
                  <div className="row gap">
                    <button type="submit" className="ui-button ui-button--primary" disabled={decide.isPending}>
                      {t('sas.restore.decide.confirm.action')}
                    </button>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDeciding(undefined)}>
                      {t('sas.restore.decide.abort.action')}
                    </button>
                  </div>
                </form>
              )}
              {items.map((entry) =>
                opened === entry.id && entry.report !== undefined ? <ReportPanel key={entry.id} report={entry.report} reference={entry.reportRef} restoredTo={entry.restoredTo} day={day} /> : null,
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
    </section>
  );
}
