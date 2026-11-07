import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, InfoFormula, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { useSodExceptions, useSodMatrix } from './hooks';
import { actionLabel, scopeLabel, severityLabel, severityTone, statusLabel, statusTone } from './labels';
import { APPROVE_PERMISSION, READ_PERMISSION, REQUEST_PERMISSION, REVOKE_PERMISSION, STATUSES, daysLeft, pairKeyOf, todayOf } from './model';
import type { ExceptionView, Status } from './model';
import { ApproveDialog, RejectDialog, RequestDialog, RevokeDialog } from './SodDialogs';
import '../adm-kit.css';
import './sod.css';

/**
 * ADM-24: the matrix of duties one person may not hold together (G4-1) and the register of exceptions. The matrix is the governance rule SOD_MATRIX: a pair names two duties, the group they are counted in (the same record,
 * project, contract or package), whether holding both stops the command (BLOCK) or only shows it to the auditor (WARN) and how many days an exception may last (0: none). An exception is asked for one person, one pair
 * and one subject; it counts only when the number of people the matrix asks for (two at least, never the person who asked nor the one it covers) have approved it, and it ends by itself on its last day.
 * Every number says where it comes from and that nobody confirmed it while it is the starting value.
 */
export default function SodScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <SodContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Tab = 'matrix' | 'exceptions';

function SodContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [tab, setTab] = useState<Tab>('matrix');
  const [filter, setFilter] = useState<Status | undefined>(undefined);
  const [requesting, setRequesting] = useState<{ preset?: string } | undefined>(undefined);
  const [approving, setApproving] = useState<ExceptionView | undefined>(undefined);
  const [rejecting, setRejecting] = useState<ExceptionView | undefined>(undefined);
  const [revoking, setRevoking] = useState<ExceptionView | undefined>(undefined);
  const has = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const writable = mode !== 'READ_ONLY';
  const mayRead = has(READ_PERMISSION);
  const matrix = useSodMatrix(mayRead);
  const exceptions = useSodExceptions(filter, mayRead && tab === 'exceptions');
  const matrixState = useScreenState({ isLoading: matrix.isLoading, error: matrix.error, data: matrix.data, isEmpty: (data) => (data as { conflicts: unknown[] }).conflicts.length === 0 });
  const listState = useScreenState({ isLoading: exceptions.isLoading, error: exceptions.error, data: exceptions.data });
  const today = matrix.data?.asOf ?? todayOf(new Date());
  const viewer = tenant?.membershipId;
  const mayRequest = has(REQUEST_PERMISSION) && writable;
  const mayDecide = has(APPROVE_PERMISSION) && writable;
  const mayRevoke = has(REVOKE_PERMISSION) && writable;
  const data = matrix.data;

  return (
    <section className="adm-sod" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govd.sod.title')}</h1>
          <p>{t('govd.sod.subtitle')}</p>
        </div>
        {mayRequest && data !== undefined ? (
          <button type="button" className="ui-button ui-button--primary" data-action="request" onClick={() => setRequesting({})}>
            {t('govd.sod.request.action')}
          </button>
        ) : null}
      </div>
      {data === undefined ? null : (
        <ContextBar
          items={[
            { label: t('govd.sod.context.version'), value: data.source === 'RULE' ? t('govd.sod.context.versionApproved', { version: data.ruleVersion }) : t('govd.sod.context.versionDefault') },
            { label: t('govd.sod.context.approvers'), value: String(data.approvers) },
          ]}
          asOf={data.asOf}
        />
      )}
      {data?.unverified === true ? (
        <p className="callout warning" role="note" data-testid="unverified">
          {t('govd.sod.unverified')}
        </p>
      ) : null}
      <div className="adm-sod-tabs" role="tablist" aria-label={t('govd.sod.tabs')}>
        <button type="button" className="ui-button ui-button--outline" role="tab" aria-selected={tab === 'matrix'} data-tab="matrix" onClick={() => setTab('matrix')}>
          {t('govd.sod.tab.matrix')}
        </button>
        <button type="button" className="ui-button ui-button--outline" role="tab" aria-selected={tab === 'exceptions'} data-tab="exceptions" onClick={() => setTab('exceptions')}>
          {t('govd.sod.tab.exceptions')}
        </button>
      </div>

      {tab === 'matrix' ? (
        <StateBoundary state={mayRead ? matrixState : 'denied'} onRetry={() => void matrix.refetch()}>
          {data === undefined ? null : (
            <>
              <KpiStrip label={t('govd.sod.kpi.label')}>
                <KpiTile label={t('govd.sod.kpi.pairs')} value={String(data.conflicts.length)} />
                <KpiTile label={t('govd.sod.kpi.blocking')} value={String(data.conflicts.filter((entry) => entry.severity === 'BLOCK').length)} tone="danger" />
                <KpiTile label={t('govd.sod.kpi.noException')} value={String(data.conflicts.filter((entry) => entry.maxDays === 0).length)} />
                <KpiTile label={t('govd.sod.kpi.expiring')} value={String(data.expiring)} tone={data.expiring > 0 ? 'warning' : 'default'} sub={t('govd.sod.kpi.expiring.sub')} />
              </KpiStrip>
              <SectionCard
                title={t('govd.sod.matrix.title')}
                status={
                  <InfoFormula
                    name={t('govd.sod.matrix.title')}
                    formula={data.formula}
                    source={data.sourceText}
                    asOf={data.ruleAsOf}
                    owner={t('govd.sod.owner')}
                    version={data.source === 'RULE' ? t('govd.sod.context.versionApproved', { version: data.ruleVersion }) : t('govd.sod.context.versionDefault')}
                    unverified={data.unverified}
                    labels={{
                      open: t('govd.sod.formula.open'),
                      close: t('govd.sod.formula.close'),
                      formula: t('govd.sod.formula.formula'),
                      numerator: t('govd.sod.formula.numerator'),
                      denominator: t('govd.sod.formula.denominator'),
                      exclusions: t('govd.sod.formula.exclusions'),
                      source: t('govd.sod.formula.source'),
                      asOf: t('govd.sod.formula.asOf'),
                      owner: t('govd.sod.formula.owner'),
                      version: t('govd.sod.formula.version'),
                      unverified: t('govd.sod.formula.unverified'),
                    }}
                  />
                }
              >
                <KitTable caption={t('govd.sod.matrix.caption')} testId="matrix">
                  <thead>
                    <tr>
                      <th scope="col">{t('govd.sod.column.dutyA')}</th>
                      <th scope="col">{t('govd.sod.column.dutyB')}</th>
                      <th scope="col">{t('govd.sod.column.scope')}</th>
                      <th scope="col">{t('govd.sod.column.severity')}</th>
                      <th scope="col">{t('govd.sod.column.maxDays')}</th>
                      <th scope="col">{t('govd.sod.column.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.conflicts.map((entry) => (
                      <tr key={pairKeyOf(entry)} data-pair={pairKeyOf(entry)} data-severity={entry.severity}>
                        <td>{actionLabel(t, entry.actionA)}</td>
                        <td>{actionLabel(t, entry.actionB)}</td>
                        <td>{scopeLabel(t, entry.scope)}</td>
                        <td>
                          <StatusPill tone={severityTone(entry.severity)}>{severityLabel(t, entry.severity)}</StatusPill>
                        </td>
                        <td data-testid="max-days">{entry.maxDays === 0 ? t('govd.sod.maxDays.none') : t('govd.sod.maxDays.days', { days: entry.maxDays })}</td>
                        <td>
                          {mayRequest && entry.maxDays > 0 ? (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="request-pair" onClick={() => setRequesting({ preset: pairKeyOf(entry) })}>
                              {t('govd.sod.request.pair')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
              </SectionCard>
            </>
          )}
        </StateBoundary>
      ) : (
        <StateBoundary state={mayRead ? listState : 'denied'} onRetry={() => void exceptions.refetch()}>
          <SectionCard
            title={t('govd.sod.exceptions.title')}
            actions={
              <label className="adm-sod-filter">
                <span>{t('govd.sod.filter.status')}</span>
                <select value={filter ?? ''} data-filter="status" onChange={(event) => setFilter(event.target.value === '' ? undefined : (event.target.value as Status))}>
                  <option value="">{t('govd.sod.filter.all')}</option>
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <KitTable caption={t('govd.sod.exceptions.caption')} testId="exceptions">
              <thead>
                <tr>
                  <th scope="col">{t('govd.sod.column.pair')}</th>
                  <th scope="col">{t('govd.sod.column.scope')}</th>
                  <th scope="col">{t('govd.sod.column.member')}</th>
                  <th scope="col">{t('govd.sod.column.window')}</th>
                  <th scope="col">{t('govd.sod.column.approvals')}</th>
                  <th scope="col">{t('govd.sod.column.status')}</th>
                  <th scope="col">{t('govd.sod.column.uses')}</th>
                  <th scope="col">{t('govd.sod.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(exceptions.data ?? []).map((row) => {
                  const left = row.status === 'APPROVED' ? daysLeft(row.validTo, today) : null;
                  const party = viewer !== undefined && (row.requestedBy === viewer || row.memberId === viewer);
                  return (
                    <tr key={row.id} data-exception={row.id} data-status={row.status}>
                      <td>
                        {actionLabel(t, row.actionA)} / {actionLabel(t, row.actionB)}
                        <span className="adm-kit-sub">{row.reason}</span>
                      </td>
                      <td>{scopeLabel(t, row.scope)}</td>
                      <td>
                        {row.memberName === '' ? row.memberId.slice(0, 8) : row.memberName}
                        <span className="adm-kit-sub">{t('govd.sod.requestedBy', { name: row.requestedByName === '' ? row.requestedBy.slice(0, 8) : row.requestedByName })}</span>
                      </td>
                      <td>
                        {row.validFrom} - {row.validTo}
                        {left === null ? null : <span className="adm-kit-sub">{t('govd.sod.daysLeft', { days: left })}</span>}
                      </td>
                      <td data-testid="approvals">{t('govd.sod.approvals', { given: row.approvals, needed: row.approversNeeded })}</td>
                      <td>
                        <span data-testid="status">
                          <StatusPill tone={statusTone(row.status)}>{statusLabel(t, row.status)}</StatusPill>
                        </span>
                        {row.revokeReason === null ? null : <span className="adm-kit-sub">{row.revokeReason}</span>}
                      </td>
                      <td data-testid="uses">{row.uses}</td>
                      <td className="adm-sod-actions">
                        {row.status === 'REQUESTED' && mayDecide && !party ? (
                          <>
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="approve" onClick={() => setApproving(row)}>
                              {t('govd.sod.approve.action')}
                            </button>
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="reject" onClick={() => setRejecting(row)}>
                              {t('govd.sod.reject.action')}
                            </button>
                          </>
                        ) : null}
                        {(row.status === 'REQUESTED' || row.status === 'APPROVED') && mayRevoke ? (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="revoke" onClick={() => setRevoking(row)}>
                            {t('govd.sod.revoke.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </KitTable>
          </SectionCard>
        </StateBoundary>
      )}
      {requesting === undefined || data === undefined ? null : <RequestDialog matrix={data} today={today} {...(requesting.preset === undefined ? {} : { preset: requesting.preset })} onClose={() => setRequesting(undefined)} />}
      {approving === undefined ? null : <ApproveDialog row={approving} onClose={() => setApproving(undefined)} />}
      {rejecting === undefined ? null : <RejectDialog row={rejecting} onClose={() => setRejecting(undefined)} />}
      {revoking === undefined ? null : <RevokeDialog row={revoking} onClose={() => setRevoking(undefined)} />}
    </section>
  );
}
