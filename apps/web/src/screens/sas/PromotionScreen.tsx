import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useAbortPromotion, useApproveCutover, useMigrationDetail, useMigrations, useNow, usePlacements, useStartPromotion } from './promotion/hooks';
import { placementLabel, problemMessage, statusLabel, statusTone } from './promotion/labels';
import {
  DEFAULT_FREEZE_MINUTES,
  MANAGE_PERMISSION,
  MAX_FREEZE_MINUTES,
  MAX_REASON,
  MIN_FREEZE_MINUTES,
  READ_PERMISSION,
  STEPS,
  canAbort,
  canApprove,
  clockOf,
  describeProblem,
  freezeRemainingMs,
  isInteresting,
  isMinutesValid,
  isOpen,
  isReasonValid,
  isWindowValid,
  moneyTotals,
  startedByMe,
  stepState,
} from './promotion/model';
import type { DetailView, MigrationView, PlacementView, ReconciliationView } from './promotion/model';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { toneClass } from './tenants/labels';
import './tenants/sas.css';
import './billing/billing.css';
import './promotion/promotion.css';

type Doing = {
  what: 'approve' | 'abort';
  migrationId: string;
  tenantId: string | undefined;
};
type Notice = {
  what: 'started' | 'approved' | 'aborted';
  tenantId: string | undefined;
};

/** The local date and time as a `datetime-local` input writes them (to the minute), for a moment given as an ISO instant. */
const localInput = (instant: Date): string => new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * SAS-23: the promotion of a tenant from the shared pool to a database of its own (SAS.md 3.3, BR-SAS-05). The System Admin plans it (the target silo, the longest time writes may be frozen, the window, the reason); the
 * platform copies the data and compares the copy with the original table by table (rows, checksum of the keys, sums of money), which the screen shows as it is kept up to date. A second System Admin approves the cutover when
 * every table agrees; writes are then frozen for the minutes asked for, the copy is compared again, the routing is switched and the tenant is watched for 24 hours. A promotion that is not over can be aborted. The registry
 * readers see everything and write nothing.
 */
export default function PromotionScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const canManage = permissions !== undefined && permissions.includes(MANAGE_PERMISSION);
  const canRead = canManage || (permissions !== undefined && permissions.includes(READ_PERMISSION));
  if (!canRead) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
        <div className="heading">
          <div>
            <h1 id="screen-title">{t('sas.promotion.page.title')}</h1>
          </div>
        </div>
        <p className="callout warning" role="alert">
          {t('states.denied.title')}
        </p>
      </section>
    );
  }
  // The forms and the notices belong to one membership: a switch starts the screen over.
  return <PromotionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} canManage={canManage} />;
}

function PromotionContent({ route, canManage }: ScreenProps & { canManage: boolean }) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const choice = useTenantChoice();
  const migrations = useMigrations(choice.chosen, true);
  const placements = usePlacements(true);
  const start = useStartPromotion();
  const approve = useApproveCutover();
  const abort = useAbortPromotion();
  const [placementId, setPlacementId] = useState('');
  const [minutes, setMinutes] = useState(String(DEFAULT_FREEZE_MINUTES));
  const [window, setWindow] = useState(() => localInput(new Date()));
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<ReadonlySet<'placement' | 'minutes' | 'window' | 'reason'>>(new Set());
  // What was prepared belongs to the tenant it was prepared for: choosing another tenant leaves it behind, so an action meant for one never reaches another.
  const [doing, setDoing] = useState<Doing | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [picked, setPicked] = useState<{ migrationId: string; tenantId: string | undefined } | undefined>(undefined);
  const [onlyData, setOnlyData] = useState(true);

  const items = (migrations.data?.pages ?? []).flatMap((page) => page.items);
  const open = items.find((entry) => isOpen(entry.status));
  const shownId = picked !== undefined && picked.tenantId === choice.chosen && items.some((entry) => entry.id === picked.migrationId) ? picked.migrationId : (open ?? items[0])?.id;
  const detail = useMigrationDetail(shownId);
  const current = detail.data;
  const acting = doing !== undefined && doing.tenantId === choice.chosen ? doing : undefined;
  const shownNotice = notice !== undefined && notice.tenantId === choice.chosen ? notice.what : undefined;
  const state = useScreenState({
    isLoading: migrations.isLoading,
    error: migrations.error,
    data: migrations.data,
    isEmpty: () => false,
  });
  const silos = (placements.data ?? []).filter((entry) => entry.available);
  const chosenPlacement = placementId !== '' && silos.some((entry) => entry.id === placementId) ? placementId : (silos[0]?.id ?? '');
  const problem = start.isError ? describeProblem(start.error) : approve.isError ? describeProblem(approve.error) : abort.isError ? describeProblem(abort.error) : undefined;
  const busy = start.isPending || approve.isPending || abort.isPending;
  const stamp = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const selected = detail.data?.migration;
  const frozen = selected?.status === 'CutoverFrozen';
  const now = useNow(frozen);

  const resetCommands = (): void => {
    start.reset();
    approve.reset();
    abort.reset();
  };

  const pick = (tenantId: string): void => {
    setDoing(undefined);
    setNotice(undefined);
    setReason('');
    setInvalid(new Set());
    resetCommands();
    choice.choose(tenantId);
  };

  const submitStart = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !canManage || choice.chosen === undefined) return;
    const wrong = new Set<'placement' | 'minutes' | 'window' | 'reason'>();
    if (chosenPlacement === '') wrong.add('placement');
    if (!isMinutesValid(Number(minutes))) wrong.add('minutes');
    if (!isWindowValid(window)) wrong.add('window');
    if (!isReasonValid(reason)) wrong.add('reason');
    setInvalid(wrong);
    if (wrong.size > 0) return;
    resetCommands();
    setNotice(undefined);
    const tenantId = choice.chosen;
    start.mutate(
      {
        tenantId,
        toPlacementId: chosenPlacement,
        writeFreezeMaxMinutes: Number(minutes),
        plannedWindowStart: new Date(window).toISOString(),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          setNotice({ what: 'started', tenantId });
          setReason('');
          setInvalid(new Set());
        },
      },
    );
  };

  const openAction = (what: Doing['what'], migration: MigrationView): void => {
    resetCommands();
    setNotice(undefined);
    setInvalid(new Set());
    setReason('');
    setDoing({ what, migrationId: migration.id, tenantId: choice.chosen });
  };

  const submitAction = (event: FormEvent): void => {
    event.preventDefault();
    if (acting === undefined || selected === undefined || selected.id !== acting.migrationId || busy || !canManage || choice.chosen === undefined) return;
    if (!isReasonValid(reason)) {
      setInvalid(new Set(['reason']));
      return;
    }
    const input = {
      tenantId: choice.chosen,
      migrationId: selected.id,
      version: selected.version,
      reason: reason.trim(),
    };
    const finished = {
      onSuccess: () => {
        setNotice({
          what: acting.what === 'approve' ? 'approved' : 'aborted',
          tenantId: choice.chosen,
        });
        setDoing(undefined);
        setReason('');
        setInvalid(new Set());
      },
    };
    // A refusal leaves the words typed where they are: the person corrects what was refused and sends them again.
    if (acting.what === 'approve') approve.mutate(input, finished);
    else abort.mutate(input, finished);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.promotion.page.title')}</h1>
          <p>{t('sas.promotion.page.subtitle')}</p>
        </div>
      </div>
      <TenantPicker id="promotion-tenant" label={t('sas.promotion.tenant.label')} moreLabel={t('sas.promotion.tenant.more.action')} choice={{ ...choice, choose: pick }} />
      {shownNotice === undefined ? null : (
        <p className="callout" role="status">
          {shownNotice === 'started' ? t('sas.promotion.done.started') : shownNotice === 'approved' ? t('sas.promotion.done.approved') : t('sas.promotion.done.aborted')}
        </p>
      )}
      {problem === undefined ? null : (
        <div className="callout warning" role="alert" data-problem>
          <p>{problemMessage(t, problem)}</p>
          {problem.correlationId === undefined ? null : (
            <small className="sub">
              {t('sas.promotion.problem.reference', {
                id: problem.correlationId,
              })}
            </small>
          )}
        </div>
      )}
      {canManage ? (
        <div className="card">
          <h2>{t('sas.promotion.start.title')}</h2>
          <p className="sub">{t('sas.promotion.start.rule')}</p>
          {open !== undefined ? (
            <p className="callout" role="status" data-open-migration>
              {t('sas.promotion.start.open')}
            </p>
          ) : (
            <StartForm
              silos={silos}
              loading={placements.isLoading}
              chosenPlacement={chosenPlacement}
              onPlacement={setPlacementId}
              minutes={minutes}
              onMinutes={setMinutes}
              window={window}
              onWindow={setWindow}
              reason={reason}
              onReason={setReason}
              invalid={invalid}
              busy={busy}
              canStart={choice.chosen !== undefined}
              onSubmit={submitStart}
            />
          )}
        </div>
      ) : null}
      <StateBoundary state={state} onRetry={() => void migrations.refetch()}>
        <div className="card">
          <h2>{t('sas.promotion.list.title')}</h2>
          <p className="sub">{t('sas.promotion.list.rule')}</p>
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.promotion.list.none')}
            </p>
          ) : (
            <div className="promotion-scroll">
              <table className="table" data-migrations>
                <thead>
                  <tr>
                    <th scope="col">{t('sas.promotion.column.status')}</th>
                    <th scope="col">{t('sas.promotion.column.target')}</th>
                    <th scope="col">{t('sas.promotion.column.freeze')}</th>
                    <th scope="col">{t('sas.promotion.column.created')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('sas.promotion.column.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((entry) => (
                    <tr key={entry.id} data-migration-id={entry.id} data-status={entry.status} aria-current={entry.id === shownId ? 'true' : undefined}>
                      <td>
                        <span className={toneClass(statusTone(entry.status))}>{statusLabel(t, entry.status)}</span>
                      </td>
                      <td>
                        <code>{targetName(t, placements.data, entry.toPlacementId)}</code>
                      </td>
                      <td>
                        {t('sas.promotion.freeze.minutes', {
                          minutes: entry.writeFreezeMaxMinutes,
                        })}
                      </td>
                      <td>{stamp(entry.createdAt)}</td>
                      <td>
                        <button
                          type="button"
                          disabled={entry.id === shownId}
                          onClick={() =>
                            setPicked({
                              migrationId: entry.id,
                              tenantId: choice.chosen,
                            })
                          }
                        >
                          {t('sas.promotion.list.open.action')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {migrations.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={migrations.isFetchingNextPage} onClick={() => void migrations.fetchNextPage()}>
                {t('sas.promotion.list.more.action')}
              </button>
            </div>
          ) : null}
        </div>
        {shownId === undefined ? null : detail.error !== null ? (
          <div className="callout warning" role="alert">
            <p>{t('sas.promotion.detail.error')}</p>
            <button type="button" onClick={() => void detail.refetch()}>
              {t('sas.promotion.detail.retry.action')}
            </button>
          </div>
        ) : current === undefined ? (
          <p className="sub" role="status">
            {t('sas.promotion.detail.loading')}
          </p>
        ) : (
          <>
            <MigrationFacts detail={current} placements={placements.data} now={now} stamp={stamp} />
            <ReconciliationCard reconciliation={current.reconciliation} onlyData={onlyData} onOnlyData={setOnlyData} stamp={stamp} />
            {canManage ? (
              <div className="card">
                <div className="row gap">
                  {canApprove(current.migration) ? (
                    <button type="button" className="primary" disabled={busy} onClick={() => openAction('approve', current.migration)}>
                      {t('sas.promotion.approve.action')}
                    </button>
                  ) : null}
                  {canAbort(current.migration.status) ? (
                    <button type="button" disabled={busy} onClick={() => openAction('abort', current.migration)}>
                      {t('sas.promotion.abort.action')}
                    </button>
                  ) : null}
                </div>
                {acting === undefined || acting.migrationId !== current.migration.id ? null : (
                  <form onSubmit={submitAction} noValidate aria-label={t('sas.promotion.act.aria')} className="billing-issue">
                    <p className="callout">{actionRule(t, acting.what, current.migration, startedByMe(current.migration, tenant?.membershipId))}</p>
                    <div className="field">
                      <label htmlFor="promotion-act-reason">{t('sas.promotion.act.reason.label')}</label>
                      <textarea
                        id="promotion-act-reason"
                        rows={2}
                        maxLength={MAX_REASON}
                        value={reason}
                        readOnly={busy}
                        aria-invalid={invalid.has('reason')}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      {invalid.has('reason') ? (
                        <small role="alert" className="field-error">
                          {t('sas.promotion.act.reason.tooShort')}
                        </small>
                      ) : null}
                    </div>
                    <div className="row gap">
                      <button type="submit" className="primary" disabled={busy}>
                        {acting.what === 'approve' ? t('sas.promotion.approve.confirm.action') : t('sas.promotion.abort.confirm.action')}
                      </button>
                      <button type="button" disabled={busy} onClick={() => setDoing(undefined)}>
                        {t('sas.promotion.act.cancel.action')}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ) : null}
          </>
        )}
      </StateBoundary>
    </section>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

const targetName = (t: T, placements: PlacementView[] | undefined, id: string): string => {
  const found = placements?.find((entry) => entry.id === id);
  return found === undefined
    ? id.slice(0, 8)
    : t('sas.promotion.target.name', {
        region: found.region,
        id: id.slice(0, 8),
      });
};

function actionRule(t: T, what: Doing['what'], migration: MigrationView, mine: boolean): string {
  if (what === 'approve')
    return mine
      ? t('sas.promotion.approve.self')
      : t('sas.promotion.approve.rule', {
          minutes: migration.writeFreezeMaxMinutes,
        });
  if (migration.status === 'CutoverFrozen') return t('sas.promotion.abort.rule.frozen');
  if (migration.status === 'Switched') return t('sas.promotion.abort.rule.switched');
  return t('sas.promotion.abort.rule.before');
}

interface StartFormProps {
  silos: PlacementView[];
  loading: boolean;
  chosenPlacement: string;
  onPlacement(id: string): void;
  minutes: string;
  onMinutes(value: string): void;
  window: string;
  onWindow(value: string): void;
  reason: string;
  onReason(value: string): void;
  invalid: ReadonlySet<'placement' | 'minutes' | 'window' | 'reason'>;
  busy: boolean;
  canStart: boolean;
  onSubmit(event: FormEvent): void;
}

function StartForm(props: StartFormProps) {
  const { t } = useTranslation();
  return (
    <form onSubmit={props.onSubmit} noValidate aria-label={t('sas.promotion.start.aria')} className="billing-issue">
      <div className="field">
        <label htmlFor="promotion-placement">{t('sas.promotion.start.placement.label')}</label>
        <select
          id="promotion-placement"
          value={props.chosenPlacement}
          disabled={props.busy || props.silos.length === 0}
          aria-invalid={props.invalid.has('placement')}
          onChange={(event) => props.onPlacement(event.target.value)}
        >
          {props.silos.map((silo) => (
            <option key={silo.id} value={silo.id}>
              {placementLabel(t, silo)}
            </option>
          ))}
        </select>
        {!props.loading && props.silos.length === 0 ? <small className="sub">{t('sas.promotion.start.placement.none')}</small> : null}
        {props.invalid.has('placement') ? (
          <small role="alert" className="field-error">
            {t('sas.promotion.start.placement.invalid')}
          </small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="promotion-minutes">{t('sas.promotion.start.minutes.label')}</label>
        <input
          id="promotion-minutes"
          type="number"
          min={MIN_FREEZE_MINUTES}
          max={MAX_FREEZE_MINUTES}
          step={1}
          value={props.minutes}
          readOnly={props.busy}
          aria-invalid={props.invalid.has('minutes')}
          onChange={(event) => props.onMinutes(event.target.value)}
        />
        <small className="sub">
          {t('sas.promotion.start.minutes.hint', {
            min: MIN_FREEZE_MINUTES,
            max: MAX_FREEZE_MINUTES,
          })}
        </small>
        {props.invalid.has('minutes') ? (
          <small role="alert" className="field-error">
            {t('sas.promotion.start.minutes.invalid', {
              min: MIN_FREEZE_MINUTES,
              max: MAX_FREEZE_MINUTES,
            })}
          </small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="promotion-window">{t('sas.promotion.start.window.label')}</label>
        <input
          id="promotion-window"
          type="datetime-local"
          value={props.window}
          readOnly={props.busy}
          aria-invalid={props.invalid.has('window')}
          onChange={(event) => props.onWindow(event.target.value)}
        />
        <small className="sub">{t('sas.promotion.start.window.hint')}</small>
        {props.invalid.has('window') ? (
          <small role="alert" className="field-error">
            {t('sas.promotion.start.window.invalid')}
          </small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="promotion-reason">{t('sas.promotion.start.reason.label')}</label>
        <textarea
          id="promotion-reason"
          rows={2}
          maxLength={MAX_REASON}
          value={props.reason}
          readOnly={props.busy}
          aria-invalid={props.invalid.has('reason')}
          onChange={(event) => props.onReason(event.target.value)}
        />
        {props.invalid.has('reason') ? (
          <small role="alert" className="field-error">
            {t('sas.promotion.start.reason.tooShort')}
          </small>
        ) : null}
      </div>
      <div className="row gap">
        <button type="submit" className="primary" disabled={props.busy || !props.canStart}>
          {t('sas.promotion.start.submit.action')}
        </button>
      </div>
    </form>
  );
}

interface FactsProps {
  detail: DetailView;
  placements: PlacementView[] | undefined;
  now: number;
  stamp(value: string): string;
}

function MigrationFacts({ detail, placements, now, stamp }: FactsProps) {
  const { t } = useTranslation();
  const migration = detail.migration;
  const reconciliation = detail.reconciliation;
  const left = freezeRemainingMs(migration, now);
  const verdict =
    reconciliation === undefined
      ? t('sas.promotion.result.none')
      : reconciliation.match
        ? t('sas.promotion.result.match')
        : t('sas.promotion.result.mismatch', {
            count: reconciliation.mismatchedTables.length,
          });
  return (
    <div className="card" data-migration-detail data-status={migration.status}>
      <h2>{t('sas.promotion.detail.title')}</h2>
      <ol className="steps" data-steps aria-label={t('sas.promotion.steps.aria')}>
        {STEPS.map((step) => (
          <li key={step} data-step={step} data-state={stepState(migration.status, step)} aria-current={stepState(migration.status, step) === 'current' ? 'step' : undefined}>
            {statusLabel(t, step)}
          </li>
        ))}
      </ol>
      <dl className="kv">
        <dt>{t('sas.promotion.field.status')}</dt>
        <dd data-field="status">
          <span className={toneClass(statusTone(migration.status))}>{statusLabel(t, migration.status)}</span>
          {migration.lastErrorCode === undefined ? null : (
            <small className="sub" data-last-error>
              {' · '}
              {t('sas.promotion.field.lastError', {
                code: migration.lastErrorCode,
              })}
            </small>
          )}
        </dd>
        <dt>{t('sas.promotion.field.target')}</dt>
        <dd data-field="target">
          <code>{targetName(t, placements, migration.toPlacementId)}</code>
        </dd>
        <dt>{t('sas.promotion.field.freeze')}</dt>
        <dd data-field="freeze">
          {t('sas.promotion.freeze.minutes', {
            minutes: migration.writeFreezeMaxMinutes,
          })}
          {left === undefined ? null : (
            <strong data-countdown role="timer" aria-live="off">
              {' · '}
              {t('sas.promotion.freeze.left', { left: clockOf(left) })}
            </strong>
          )}
        </dd>
        <dt>{t('sas.promotion.field.result')}</dt>
        <dd data-field="result">
          <span className={toneClass(reconciliation === undefined ? 'gray' : reconciliation.match ? 'ok' : 'red')}>{verdict}</span>
          {migration.verifiedAt === undefined ? null : (
            <small className="sub">
              {' '}
              ·{' '}
              {t('sas.promotion.field.verifiedAt', {
                at: stamp(migration.verifiedAt),
              })}
            </small>
          )}
          {migration.verificationReportRef === undefined ? null : (
            <small className="sub">
              {' · '}
              <code>{migration.verificationReportRef}</code>
            </small>
          )}
        </dd>
        <dt>{t('sas.promotion.field.approver')}</dt>
        <dd data-field="approver">{migration.cutoverApprovedBy === undefined ? '—' : <code>{migration.cutoverApprovedBy}</code>}</dd>
        <dt>{t('sas.promotion.field.initiator')}</dt>
        <dd data-field="initiator">
          <code>{migration.requestedBy}</code>
        </dd>
        <dt>{t('sas.promotion.field.window')}</dt>
        <dd>{stamp(migration.plannedWindowStart)}</dd>
        <dt>{t('sas.promotion.field.reason')}</dt>
        <dd>{migration.reason}</dd>
        {migration.switchedAt === undefined ? null : (
          <>
            <dt>{t('sas.promotion.field.switchedAt')}</dt>
            <dd>{stamp(migration.switchedAt)}</dd>
          </>
        )}
        {migration.status === 'Switched' && migration.observationEndsAt !== undefined ? (
          <>
            <dt>{t('sas.promotion.field.observationEnds')}</dt>
            <dd data-field="observation">{stamp(migration.observationEndsAt)}</dd>
          </>
        ) : null}
        {migration.completedAt === undefined ? null : (
          <>
            <dt>{t('sas.promotion.field.completedAt')}</dt>
            <dd>{stamp(migration.completedAt)}</dd>
          </>
        )}
        {migration.endedAt === undefined ? null : (
          <>
            <dt>{t('sas.promotion.field.endedAt')}</dt>
            <dd data-field="ended">
              {stamp(migration.endedAt)}
              {migration.endReason === undefined ? null : (
                <small className="sub">
                  {' '}
                  ·{' '}
                  {migration.endedBy === undefined
                    ? t('sas.promotion.field.endedBySystem', {
                        reason: migration.endReason,
                      })
                    : migration.endReason}
                </small>
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

interface ReconciliationProps {
  reconciliation: ReconciliationView | undefined;
  onlyData: boolean;
  onOnlyData(value: boolean): void;
  stamp(value: string): string;
}

function ReconciliationCard({ reconciliation, onlyData, onOnlyData, stamp }: ReconciliationProps) {
  const { t } = useTranslation();
  if (reconciliation === undefined) {
    return (
      <div className="card" data-reconciliation>
        <h2>{t('sas.promotion.recon.title')}</h2>
        <p className="sub" role="status">
          {t('sas.promotion.recon.none')}
        </p>
      </div>
    );
  }
  const shown = onlyData ? reconciliation.tables.filter(isInteresting) : reconciliation.tables;
  const totals = moneyTotals(reconciliation.tables);
  return (
    <div className="card" data-reconciliation data-match={reconciliation.match}>
      <h2>{t('sas.promotion.recon.title')}</h2>
      <p className="sub">
        {t('sas.promotion.recon.rule', {
          at: stamp(reconciliation.measuredAt),
        })}
      </p>
      <label>
        <input type="checkbox" checked={onlyData} onChange={(event) => onOnlyData(event.target.checked)} /> {t('sas.promotion.recon.filter.label')}
      </label>
      <div className="promotion-scroll">
        <table className="table" data-tables>
          <thead>
            <tr>
              <th scope="col">{t('sas.promotion.recon.column.table')}</th>
              <th scope="col">{t('sas.promotion.recon.column.rows')}</th>
              <th scope="col">{t('sas.promotion.recon.column.checksum')}</th>
              <th scope="col">{t('sas.promotion.recon.column.money')}</th>
              <th scope="col">{t('sas.promotion.recon.column.result')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((table) => (
              <tr key={table.table} data-table-name={table.table} data-match={table.match}>
                <td>
                  <code>{table.table}</code>
                </td>
                <td data-rows>
                  {t('sas.promotion.recon.rows', {
                    source: table.sourceRows ?? '—',
                    target: table.targetRows ?? '—',
                  })}
                </td>
                <td data-checksum>{table.checksumMatch ? t('sas.promotion.recon.same') : t('sas.promotion.recon.differs')}</td>
                <td data-money>
                  {table.money.length === 0
                    ? '—'
                    : table.money.map((entry) => (
                        <div key={entry.column} data-money-column={entry.column} data-money-match={entry.match}>
                          <code>{entry.column}</code>: {entry.source ?? '—'} → {entry.target ?? '—'}
                        </div>
                      ))}
                </td>
                <td data-result>
                  <span className={toneClass(table.match ? 'ok' : 'red')}>{table.match ? t('sas.promotion.recon.ok') : t('sas.promotion.recon.differs')}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-totals>
              <th scope="row">{t('sas.promotion.recon.totals')}</th>
              <td data-total-rows>
                {t('sas.promotion.recon.rows', {
                  source: reconciliation.sourceRows,
                  target: reconciliation.targetRows,
                })}
              </td>
              <td />
              <td data-total-money>
                {totals.map((entry) => (
                  <div key={entry.column} data-total-column={entry.column}>
                    <code>{entry.column}</code>: {entry.source} → {entry.target}
                  </div>
                ))}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {reconciliation.unreadableTables.length === 0 ? null : (
        <p className="sub" data-unreadable>
          {t('sas.promotion.recon.unreadable', {
            tables: reconciliation.unreadableTables.join(', '),
          })}
        </p>
      )}
    </div>
  );
}
