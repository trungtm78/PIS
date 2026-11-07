import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../../adm/KitTable';
import { useSodExceptions, useSodUses } from '../../adm/sod/hooks';
import { actionLabel, outcomeLabel, outcomeTone, scopeLabel, statusLabel, statusTone } from '../../adm/sod/labels';
import { AUDIT_PERMISSION, OUTCOMES, STATUSES } from '../../adm/sod/model';
import type { Outcome, Status } from '../../adm/sod/model';
import '../../adm/adm-kit.css';
import '../../adm/sod/sod.css';

/**
 * AUD-13: what the auditor reads of the separation of duties (G4-1). The exceptions that were asked for, approved, rejected, revoked or have ended, with who asked, who covered, who approved how many times and how often
 * each was used; and every command that met a conflict: the ones that went through by an exception, the ones that went through because the pair is only a warning, and the ones that were refused. The screen only reads.
 */
export default function SodAuditScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <SodAuditContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Tab = 'uses' | 'exceptions';

function SodAuditContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const [tab, setTab] = useState<Tab>('uses');
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(AUDIT_PERMISSION);
  const uses = useSodUses(outcome, mayRead && tab === 'uses');
  const exceptions = useSodExceptions(status, mayRead && tab === 'exceptions', true);
  const usesState = useScreenState({ isLoading: uses.isLoading, error: uses.error, data: uses.data });
  const exceptionsState = useScreenState({ isLoading: exceptions.isLoading, error: exceptions.error, data: exceptions.data });
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));

  return (
    <section className="aud-sod" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govd.sodaudit.title')}</h1>
          <p>{t('govd.sodaudit.subtitle')}</p>
        </div>
      </div>
      <div className="adm-sod-tabs" role="tablist" aria-label={t('govd.sodaudit.tabs')}>
        <button type="button" className="ui-button ui-button--outline" role="tab" aria-selected={tab === 'uses'} data-tab="uses" onClick={() => setTab('uses')}>
          {t('govd.sodaudit.tab.uses')}
        </button>
        <button type="button" className="ui-button ui-button--outline" role="tab" aria-selected={tab === 'exceptions'} data-tab="exceptions" onClick={() => setTab('exceptions')}>
          {t('govd.sodaudit.tab.exceptions')}
        </button>
      </div>
      {tab === 'uses' ? (
        <StateBoundary state={mayRead ? usesState : 'denied'} onRetry={() => void uses.refetch()}>
          <SectionCard
            title={t('govd.sodaudit.uses.title')}
            actions={
              <label className="adm-sod-filter">
                <span>{t('govd.sodaudit.filter.outcome')}</span>
                <select value={outcome ?? ''} data-filter="outcome" onChange={(event) => setOutcome(event.target.value === '' ? undefined : (event.target.value as Outcome))}>
                  <option value="">{t('govd.sod.filter.all')}</option>
                  {OUTCOMES.map((entry) => (
                    <option key={entry} value={entry}>
                      {outcomeLabel(t, entry)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <KitTable caption={t('govd.sodaudit.uses.caption')} testId="uses">
              <thead>
                <tr>
                  <th scope="col">{t('govd.sodaudit.column.when')}</th>
                  <th scope="col">{t('govd.sodaudit.column.member')}</th>
                  <th scope="col">{t('govd.sodaudit.column.taking')}</th>
                  <th scope="col">{t('govd.sod.column.pair')}</th>
                  <th scope="col">{t('govd.sod.column.scope')}</th>
                  <th scope="col">{t('govd.sodaudit.column.command')}</th>
                  <th scope="col">{t('govd.sodaudit.column.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {(uses.data ?? []).map((row) => (
                  <tr key={row.id} data-use={row.id} data-outcome={row.outcome}>
                    <td>{moment(row.usedAt)}</td>
                    <td>{row.memberName}</td>
                    <td>{actionLabel(t, row.taking)}</td>
                    <td>
                      {actionLabel(t, row.actionA)} / {actionLabel(t, row.actionB)}
                      <span className="adm-kit-sub">{t('govd.sodaudit.ruleVersion', { version: row.ruleVersion })}</span>
                    </td>
                    <td>{scopeLabel(t, row.scope)}</td>
                    <td>{row.command}</td>
                    <td>
                      <span data-testid="outcome">
                        <StatusPill tone={outcomeTone(row.outcome)}>{outcomeLabel(t, row.outcome)}</StatusPill>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          </SectionCard>
        </StateBoundary>
      ) : (
        <StateBoundary state={mayRead ? exceptionsState : 'denied'} onRetry={() => void exceptions.refetch()}>
          <SectionCard
            title={t('govd.sodaudit.exceptions.title')}
            actions={
              <label className="adm-sod-filter">
                <span>{t('govd.sod.filter.status')}</span>
                <select value={status ?? ''} data-filter="status" onChange={(event) => setStatus(event.target.value === '' ? undefined : (event.target.value as Status))}>
                  <option value="">{t('govd.sod.filter.all')}</option>
                  {STATUSES.map((entry) => (
                    <option key={entry} value={entry}>
                      {statusLabel(t, entry)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <KitTable caption={t('govd.sodaudit.exceptions.caption')} testId="exceptions">
              <thead>
                <tr>
                  <th scope="col">{t('govd.sod.column.pair')}</th>
                  <th scope="col">{t('govd.sod.column.scope')}</th>
                  <th scope="col">{t('govd.sod.column.member')}</th>
                  <th scope="col">{t('govd.sod.column.window')}</th>
                  <th scope="col">{t('govd.sod.column.approvals')}</th>
                  <th scope="col">{t('govd.sod.column.status')}</th>
                  <th scope="col">{t('govd.sod.column.uses')}</th>
                </tr>
              </thead>
              <tbody>
                {(exceptions.data ?? []).map((row) => (
                  <tr key={row.id} data-exception={row.id} data-status={row.status}>
                    <td>
                      {actionLabel(t, row.actionA)} / {actionLabel(t, row.actionB)}
                      <span className="adm-kit-sub">{row.reason}</span>
                    </td>
                    <td>{scopeLabel(t, row.scope)}</td>
                    <td>
                      {row.memberName}
                      <span className="adm-kit-sub">{t('govd.sod.requestedBy', { name: row.requestedByName })}</span>
                    </td>
                    <td>
                      {row.validFrom} - {row.validTo}
                    </td>
                    <td data-testid="approvals">{t('govd.sod.approvals', { given: row.approvals, needed: row.approversNeeded })}</td>
                    <td>
                      <span data-testid="status">
                        <StatusPill tone={statusTone(row.status)}>{statusLabel(t, row.status)}</StatusPill>
                      </span>
                    </td>
                    <td data-testid="uses">{row.uses}</td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          </SectionCard>
        </StateBoundary>
      )}
    </section>
  );
}
