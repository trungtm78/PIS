import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { useReputation, useVentures } from '../shared/vnd-hooks';
import { behaviourLabel, eventStatusLabel, ventureStatusLabel } from '../shared/vnd-labels';
import { PATHS, PERMISSION, dayText, isUuid, vietnamStamp } from '../shared/vnd-model';
import type { ReputationEvent, Venture } from '../shared/vnd-model';
import { ClockCell, CountInfo, Empty, PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { CreateVentureDialog, EndVentureDialog, PostDialog, RecordEventDialog, RetractDialog } from './reputation-dialogs';

const NONE = '–';
const EVENT_STATUSES = ['RECORDED', 'POSTED', 'RETRACTED'] as const;
const VENTURE_STATUSES = ['ACTIVE', 'ENDED'] as const;

type Dialog = { kind: 'record' } | { kind: 'post'; event: ReputationEvent } | { kind: 'retract'; event: ReputationEvent } | { kind: 'create' } | { kind: 'end'; venture: Venture };

/**
 * VND-06, the events of bid conduct and the joint ventures. An event is recorded, then posted on the national network within seven working days by the rule (not verified) by another person, who gives the receipt; one recorded in
 * error is retracted with a reason. A posted event raises the bid security of the contractor. A joint venture has members with their shares (total 100) and one lead. An id in the address (`?event=`) marks that event.
 */
export default function ReputationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const focus = useIdParam('event', 'id');
  const contractor = useIdParam('contractor');
  return <ReputationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} focus={focus} contractor={contractor} />;
}

function ReputationContent({ route, focus, contractor }: ScreenProps & { focus: string | undefined; contractor: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [eventStatus, setEventStatus] = useState('');
  const [ventureStatus, setVentureStatus] = useState('');
  const events = useReputation(eventStatus);
  const ventures = useVentures(ventureStatus);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const data = events.data;
  const state = useScreenState({ isLoading: events.isLoading, error: data === undefined ? events.error : undefined, data, isEmpty: () => false });
  const refreshFailed = events.isError && data !== undefined;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  const canRecord = writer.can(PERMISSION.reputationWrite);
  const canVenture = writer.can(PERMISSION.ventureWrite);
  const marked = data?.items.find((item) => item.id === focus);

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.reputation.page.title')}
        subtitle={t('vnd.reputation.page.subtitle')}
        asOf={data?.as_of}
        stale={refreshFailed}
        actions={
          <>
            {canVenture && (
              <button type="button" className="ui-button ui-button--outline" data-testid="create-venture" onClick={() => setDialog({ kind: 'create' })}>
                {t('vnd.ventures.create.action')}
              </button>
            )}
            {canRecord && (
              <button type="button" className="ui-button ui-button--primary" data-testid="record-event" onClick={() => setDialog({ kind: 'record' })}>
                {t('vnd.reputation.record.action')}
              </button>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void events.refetch()} />}
      {focus !== undefined && data !== undefined && marked === undefined && (
        <p className="callout" role="status" data-testid="event-not-in-list">
          {t('vnd.reputation.focus.missing.text')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void events.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnd.reputation.section.events.title')} status={data.deadline_policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row" data-testid="reputation-rule">
                <span>{t('vnd.reputation.rule.text')}</span>
                <PolicyInfo name={t('vnd.reputation.figure.deadline.name')} policy={data.deadline_policy} />
              </p>
              <p className="vnd-note vnd-row" data-testid="security-rule">
                <span>{t('vnd.reputation.security.text')}</span>
                <PolicyInfo name={t('vnd.reputation.figure.security.name')} policy={data.policy} />
                {data.policy.unverified && <UnverifiedPill />}
              </p>
              <div className="vnd-filters">
                <label>
                  {t('vnd.reputation.filter.status.label')}
                  <select value={eventStatus} onChange={(event) => setEventStatus(event.target.value)}>
                    <option value="">{t('vnd.register.filter.any.option')}</option>
                    {EVENT_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {eventStatusLabel(t, status)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <DataTable<ReputationEvent>
                caption={t('vnd.reputation.table.caption')}
                rows={data.items}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-event-id': row.id, 'data-focus': row.id === focus ? 'true' : 'false' })}
                state={data.items.length === 0 ? 'empty' : 'ready'}
                emptyKind={eventStatus === '' ? 'none' : 'filtered'}
                onClearFilters={() => setEventStatus('')}
                severity={(row) => (row.status === 'RECORDED' && row.clock === 'OVERDUE' ? 'URGENT' : row.status === 'RECORDED' && row.clock === 'DUE_SOON' ? 'ACTION' : null)}
                columns={[
                  {
                    key: 'contractor',
                    header: t('vnd.reputation.column.contractor'),
                    pinned: true,
                    render: (row) => (
                      <span className="vnd-stack">
                        <Link to={PATHS.profile(row.contractor_id)}>{row.contractor_name}</Link>
                        {row.id === focus && <StatusPill tone="info">{t('vnd.reputation.focus.badge')}</StatusPill>}
                      </span>
                    ),
                  },
                  {
                    key: 'behaviour',
                    header: t('vnd.reputation.column.behaviour'),
                    render: (row) => (
                      <span className="vnd-stack">
                        <span>{behaviourLabel(t, row.behaviour_code)}</span>
                        <span className="vnd-days">{row.description}</span>
                      </span>
                    ),
                  },
                  { key: 'on', header: t('vnd.reputation.column.on'), render: (row) => dayText(row.event_on) },
                  {
                    key: 'status',
                    header: t('vnd.reputation.column.status'),
                    render: (row) => (
                      <span className="vnd-stack">
                        <StatusPill tone={row.status === 'POSTED' ? 'success' : row.status === 'RETRACTED' ? 'neutral' : 'info'}>{eventStatusLabel(t, row.status)}</StatusPill>
                        <span className="vnd-days">{t('vnd.reputation.recorded.text', { name: row.recorded_by_name ?? NONE, time: vietnamStamp(row.recorded_at) })}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'clock',
                    header: t('vnd.reputation.column.clock'),
                    render: (row) =>
                      row.status === 'RETRACTED' ? (
                        NONE
                      ) : (
                        <span className="vnd-stack">
                          <ClockCell clock={row.clock} dueAt={row.post_due_at} asOf={data.as_of} />
                          <span className="vnd-days">{t('vnd.reputation.due.text', { time: vietnamStamp(row.post_due_at) })}</span>
                        </span>
                      ),
                  },
                  {
                    key: 'posted',
                    header: t('vnd.reputation.column.posted'),
                    render: (row) =>
                      row.status === 'POSTED' ? (
                        <span className="vnd-stack">
                          <span>{t('vnd.reputation.posted.text', { name: row.posted_by_name ?? NONE, time: row.posted_at === null ? NONE : vietnamStamp(row.posted_at) })}</span>
                          <span className="vnd-days">{t('vnd.reputation.receipt.text', { receipt: row.posting_ref ?? NONE })}</span>
                        </span>
                      ) : row.status === 'RETRACTED' ? (
                        <span className="vnd-days">{row.retract_reason ?? NONE}</span>
                      ) : (
                        NONE
                      ),
                  },
                  {
                    key: 'actions',
                    header: t('vnd.reputation.column.actions'),
                    render: (row) => (
                      <span className="vnd-row">
                        {!writer.readOnly && row.may_post && row.status === 'RECORDED' && (
                          <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="post-event" onClick={() => setDialog({ kind: 'post', event: row })}>
                            {t('vnd.reputation.post.action')}
                          </button>
                        )}
                        {!writer.readOnly && row.may_retract && row.status !== 'RETRACTED' && (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="retract-event" onClick={() => setDialog({ kind: 'retract', event: row })}>
                            {t('vnd.reputation.retract.action')}
                          </button>
                        )}
                      </span>
                    ),
                  },
                ]}
              />
              <p className="vnd-row">
                <CountInfo name={t('vnd.reputation.figure.count.name')} formula={t('vnd.reputation.figure.count.formula')} source={t('vnd.reputation.figure.count.source')} asOf={data.as_of} />
              </p>
            </SectionCard>
            <VentureSection
              query={ventures}
              status={ventureStatus}
              onStatus={setVentureStatus}
              canEnd={canVenture}
              onEnd={(venture) => setDialog({ kind: 'end', venture })}
            />
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'record' && <RecordEventDialog initialContractor={contractor !== undefined && isUuid(contractor) ? contractor : ''} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.reputation.record.title'))} />}
      {dialog?.kind === 'post' && <PostDialog event={dialog.event} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.reputation.post.title'))} />}
      {dialog?.kind === 'retract' && <RetractDialog event={dialog.event} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.reputation.retract.title'))} />}
      {dialog?.kind === 'create' && <CreateVentureDialog onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.ventures.create.title'))} />}
      {dialog?.kind === 'end' && <EndVentureDialog venture={dialog.venture} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.ventures.end.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function VentureSection({ query, status, onStatus, canEnd, onEnd }: { query: ReturnType<typeof useVentures>; status: string; onStatus: (status: string) => void; canEnd: boolean; onEnd: (venture: Venture) => void }) {
  const { t } = useTranslation();
  const data = query.data;
  return (
    <SectionCard title={t('vnd.ventures.section.title')}>
      <p className="vnd-note" data-testid="ventures-rule">
        {t('vnd.ventures.rule.text')}
      </p>
      <div className="vnd-filters">
        <label>
          {t('vnd.ventures.filter.status.label')}
          <select value={status} onChange={(event) => onStatus(event.target.value)}>
            <option value="">{t('vnd.register.filter.any.option')}</option>
            {VENTURE_STATUSES.map((item) => (
              <option key={item} value={item}>
                {ventureStatusLabel(t, item)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {query.isLoading && (
        <p className="vnd-none" role="status" aria-busy="true" data-testid="ventures-loading">
          {t('states.loading.label')}
        </p>
      )}
      {query.isError && <PartialNotice text={t('vnd.ventures.error.text')} onRetry={() => void query.refetch()} testId="ventures-error" />}
      {data !== undefined &&
        (data.items.length === 0 ? (
          <Empty text={status === '' ? t('vnd.ventures.empty.text') : t('vnd.ventures.emptyFiltered.text')} testId="ventures-empty" />
        ) : (
          <DataTable<Venture>
            caption={t('vnd.ventures.table.caption')}
            rows={data.items}
            rowKey={(row) => row.id}
            rowAttrs={(row) => ({ 'data-venture-id': row.id })}
            columns={[
              { key: 'name', header: t('vnd.ventures.column.name'), pinned: true, render: (row) => row.name },
              { key: 'status', header: t('vnd.ventures.column.status'), render: (row) => <StatusPill tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{ventureStatusLabel(t, row.status)}</StatusPill> },
              {
                key: 'members',
                header: t('vnd.ventures.column.members'),
                render: (row) => (
                  <ul className="vnd-list">
                    {row.members.map((member) => (
                      <li key={member.contractor_id}>
                        <Link to={PATHS.profile(member.contractor_id)}>{member.contractor_name}</Link> {t('vnd.ventures.share.text', { share: member.share_pct })}
                        {member.lead && <StatusPill tone="info">{t('vnd.ventures.lead.badge')}</StatusPill>}
                      </li>
                    ))}
                  </ul>
                ),
              },
              { key: 'period', header: t('vnd.ventures.column.period'), render: (row) => `${dayText(row.starts_on)} – ${row.ends_on === null ? t('vnd.ventures.period.open') : dayText(row.ends_on)}` },
              {
                key: 'actions',
                header: t('vnd.ventures.column.actions'),
                render: (row) =>
                  canEnd && row.status === 'ACTIVE' ? (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="end-venture" onClick={() => onEnd(row)}>
                      {t('vnd.ventures.end.action')}
                    </button>
                  ) : row.ended_reason === null ? null : (
                    <span className="vnd-days">{row.ended_reason}</span>
                  ),
              },
            ]}
          />
        ))}
    </SectionCard>
  );
}
