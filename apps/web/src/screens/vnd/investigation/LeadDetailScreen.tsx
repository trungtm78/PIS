import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, MakerCheckerBadge, SectionCard, StatusPill, Timeline } from '../../../ui';
import { PATHS, vietnamDay } from '../shared/vnd-model';
import { Fact, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { ContractorLinksPanel } from './ContractorLinksPanel';
import { LeadMoveDialog } from './lead-dialogs';
import type { LeadMove } from './lead-dialogs';
import { useLead } from './investigation-hooks';
import { evidenceKeyLabel, evidenceValueText, leadKindLabel, leadMoveLabel, leadStatusLabel } from './investigation-labels';
import { INV_PATHS, INV_PERMISSION, dayText, historyGroups, leadTone, nodesOfLead, rankTone, traceShares, vietnamStamp } from './investigation-model';
import type { LeadDetail, LeadSignal } from './investigation-model';
import { LinkGraph } from './LinkGraph';
import './investigation.css';

const hiddenError = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * VND-14, one lead of the investigation: its signals with the numbers they rest on, the contractors, the links as a graph that can be read without the picture (a table under it), the history, and the review in two steps:
 * take, propose a dismissal with a reason, a DIFFERENT auditor confirms it or sends it back; or confirm the signal as right (which measures the false alarms), or refer it. The buttons offered are the ones the server says
 * the caller may press; a person who took part in the packages gets 404 and the page says the scope is hidden without naming anything. A lead is a signal for review, never a conclusion.
 */
export default function LeadDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const id = useIdParam('lead', 'id');
  return <LeadDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${id ?? ''}`} route={route} id={id} />;
}

function LeadDetailContent({ route, id }: ScreenProps & { id: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = useLead(id);
  const receipt = useReceipt();
  const [dialog, setDialog] = useState<LeadMove | undefined>(undefined);
  const [focus, setFocus] = useState<string | null>(null);
  const data = query.data;
  const hidden = data === undefined && hiddenError(query.error);
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined && !hidden ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const done = (move: LeadMove): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what: t(`vnd3.leadMove.${move}.title`), time: vietnamStamp(new Date().toISOString()) }));
  };

  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd3.lead.page.title')} subtitle={t('vnd3.lead.page.subtitle')} asOf={data?.as_of} stale={refreshFailed} actions={<Link to={INV_PATHS.leads}>{t('vnd3.lead.back.action')}</Link>} />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      <p className="callout inv-notice" data-testid="signal-notice">
        {t('vnd3.leads.notice.text')}
      </p>
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      {id === undefined && (
        <p className="callout" role="status" data-testid="lead-missing">
          {t('vnd3.lead.missing.text')}
        </p>
      )}
      {hidden && (
        <p className="callout" role="alert" data-testid="lead-hidden">
          {t('vnd3.lead.hidden.text')}
        </p>
      )}
      {id !== undefined && !hidden && (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {data !== undefined && (
            <div className="vnd-page">
              <Summary data={data} />
              <ReviewSection data={data} canReview={!writer.readOnly} onMove={setDialog} />
              <SectionCard title={t('vnd3.lead.section.graph.title')} status={data.policies.link.unverified ? <UnverifiedPill /> : undefined}>
                <p className="vnd-row" data-testid="link-policy">
                  <span>{t('vnd3.lead.graph.rule.text')}</span>
                  <PolicyInfo name={t('vnd3.lead.graph.rule.name')} policy={data.policies.link} />
                </p>
                <LinkGraph nodes={nodesOfLead(data.contractors)} links={data.links} focusId={focus} title={t('vnd3.lead.graph.title')} />
                <label className="vnd-filters">
                  <span>{t('vnd3.lead.focus.label')}</span>
                  <select value={focus ?? ''} onChange={(event) => setFocus(event.target.value === '' ? null : event.target.value)} data-testid="focus-select">
                    <option value="">{t('vnd3.lead.focus.none.option')}</option>
                    {data.contractors.map((contractor) => (
                      <option key={contractor.id} value={contractor.id}>
                        {contractor.name}
                      </option>
                    ))}
                  </select>
                </label>
              </SectionCard>
              <SignalsSection data={data} />
              {focus !== null && <ContractorLinksPanel contractorId={focus} />}
              <SectionCard title={t('vnd3.lead.section.history.title')}>
                <Timeline caption={t('vnd3.lead.history.caption')} groups={historyGroups(data.history, (event) => `${leadMoveLabel(t, event.move)}: ${leadStatusLabel(t, event.to_status)}`)} today={vietnamDay(data.as_of)} state={data.history.length === 0 ? 'empty' : 'ready'} />
              </SectionCard>
            </div>
          )}
        </StateBoundary>
      )}
      {dialog !== undefined && data !== undefined && <LeadMoveDialog move={dialog} lead={data.lead} onClose={() => setDialog(undefined)} onDone={() => done(dialog)} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function Summary({ data }: { data: LeadDetail }) {
  const { t } = useTranslation();
  const { lead } = data;
  return (
    <SectionCard title={leadKindLabel(t, lead.kind)} status={<StatusPill tone={leadTone(lead.status)}>{leadStatusLabel(t, lead.status)}</StatusPill>}>
      <dl className="vnd-facts" data-testid="lead-facts">
        <Fact label={t('vnd3.lead.field.rank.label')} testId="fact-rank">
          <strong className="inv-rank">{lead.rank}</strong> <StatusPill tone={rankTone(lead.rank)}>{t('vnd3.leads.rank.badge')}</StatusPill>
        </Fact>
        <Fact label={t('vnd3.lead.field.kind.label')} testId="fact-kind">
          {leadKindLabel(t, lead.kind)}
        </Fact>
        <Fact label={t('vnd3.lead.field.contractors.label')} testId="fact-contractors">
          <ul className="vnd-list">
            {data.contractors.map((contractor) => (
              <li key={contractor.id}>
                <Link to={PATHS.profile(contractor.id)}>{contractor.name}</Link> {t('vnd.register.taxCode.text', { code: contractor.tax_identifier })}
                {contractor.restricted && (
                  <>
                    {' '}
                    <StatusPill tone="danger" icon="⛔">
                      {t('vnd3.graph.restricted.badge')}
                    </StatusPill>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Fact>
        <Fact label={t('vnd3.lead.field.packages.label')} testId="fact-packages">
          {lead.package_codes.length === 0 ? '–' : lead.package_codes.join(', ')}
        </Fact>
        <Fact label={t('vnd3.lead.field.flagged.label')} testId="fact-flagged">
          {t('vnd3.lead.flagged.text', { first: dayText(lead.first_flagged_at), last: dayText(lead.last_evaluated_at), count: lead.evaluation_count })}
        </Fact>
        <Fact label={t('vnd3.lead.field.reviewer.label')} testId="fact-reviewer">
          {lead.reviewer_name ?? '–'}
        </Fact>
        {lead.reopened_count > 0 && (
          <Fact label={t('vnd3.lead.field.reopened.label')} testId="fact-reopened">
            {t('vnd3.leads.reopened.text', { count: lead.reopened_count })}
          </Fact>
        )}
      </dl>
      <p className="vnd-note" data-testid="not-conclusion">
        {t('vnd3.lead.notConclusion.text')}
      </p>
    </SectionCard>
  );
}

function ReviewSection({ data, canReview, onMove }: { data: LeadDetail; canReview: boolean; onMove: (move: LeadMove) => void }) {
  const { t } = useTranslation();
  const lead = data.lead;
  const can = (flag: boolean): boolean => canReview && flag;
  const buttons: Array<{ move: LeadMove; shown: boolean; primary: boolean; testId: string }> = [
    { move: 'take', shown: can(data.may_take), primary: true, testId: 'take-lead' },
    { move: 'proposeDismissal', shown: can(data.may_propose_dismissal), primary: false, testId: 'propose-dismissal' },
    { move: 'confirmDismissal', shown: can(data.may_confirm_dismissal), primary: true, testId: 'confirm-dismissal' },
    { move: 'rejectDismissal', shown: can(data.may_reject_dismissal), primary: false, testId: 'reject-dismissal' },
    { move: 'confirmSignal', shown: can(data.may_confirm_signal), primary: false, testId: 'confirm-signal' },
    { move: 'refer', shown: can(data.may_refer), primary: false, testId: 'refer-lead' },
  ];
  const any = buttons.some((button) => button.shown);
  return (
    <SectionCard title={t('vnd3.lead.section.review.title')}>
      <p className="vnd-note" data-testid="review-rule">
        {t('vnd3.lead.review.rule.text')}
      </p>
      {lead.status === 'DISMISS_PROPOSED' && data.dismiss_proposed_by_name !== null && (
        <div className="vnd-stack" data-testid="dismissal-proposal">
          <MakerCheckerBadge maker={data.dismiss_proposed_by_name} />
          <span>{t('vnd3.lead.dismissal.reason.text', { reason: data.dismiss_reason ?? '–' })}</span>
        </div>
      )}
      {lead.status === 'CONFIRMED' && data.confirm_reason !== null && <p data-testid="confirm-reason">{t('vnd3.lead.confirmed.reason.text', { reason: data.confirm_reason })}</p>}
      {lead.status === 'REFERRED' && data.referral_reason !== null && <p data-testid="referral-reason">{t('vnd3.lead.referred.reason.text', { reason: data.referral_reason })}</p>}
      {lead.status === 'DISMISSED' && data.dismiss_reason !== null && <p data-testid="dismissed-reason">{t('vnd3.lead.dismissed.reason.text', { reason: data.dismiss_reason })}</p>}
      {any ? (
        <span className="vnd-row">
          {buttons
            .filter((button) => button.shown)
            .map((button) => (
              <button key={button.move} type="button" className={`ui-button ${button.primary ? 'ui-button--primary' : 'ui-button--outline'}`} data-testid={button.testId} onClick={() => onMove(button.move)}>
                {t(`vnd3.leadMove.${button.move}.action`)}
              </button>
            ))}
        </span>
      ) : (
        <p className="vnd-none" data-testid="no-actions">
          {t('vnd3.lead.review.none.text')}
        </p>
      )}
    </SectionCard>
  );
}

function SignalsSection({ data }: { data: LeadDetail }) {
  const { t } = useTranslation();
  const shares = traceShares(data.trace_coverage);
  const names = new Map(data.contractors.map((contractor) => [contractor.id, contractor.name]));
  return (
    <SectionCard title={t('vnd3.lead.section.signals.title')} status={data.policies.rigging.unverified ? <UnverifiedPill /> : undefined}>
      <p className="vnd-row" data-testid="rigging-policy">
        <span>{t('vnd3.lead.signals.rule.text')}</span>
        <PolicyInfo name={t('vnd3.lead.signals.rule.name')} policy={data.policies.rigging} />
      </p>
      <DataTable<LeadSignal>
        caption={t('vnd3.lead.signals.caption')}
        rows={data.signals}
        rowKey={(row) => `${row.code}:${row.package_ids.join(',')}:${row.contractor_ids.join(',')}`}
        state={data.signals.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'code', header: t('vnd3.lead.signals.column.code'), pinned: true, render: (row) => leadKindLabel(t, row.code) },
          { key: 'score', header: t('vnd3.lead.signals.column.score'), align: 'right', render: (row) => <strong>{row.score}</strong> },
          { key: 'who', header: t('vnd3.lead.signals.column.contractors'), render: (row) => row.contractor_ids.map((id) => names.get(id) ?? id.slice(0, 8)).join(', ') },
          {
            key: 'evidence',
            header: t('vnd3.lead.signals.column.evidence'),
            render: (row) => (
              <dl className="inv-evidence">
                {Object.entries(row.evidence).map(([key, value]) => (
                  <div key={key} className="vnd-row">
                    <dt>{evidenceKeyLabel(t, key)}</dt>
                    <dd>{evidenceValueText(value)}</dd>
                  </div>
                ))}
              </dl>
            ),
          },
        ]}
      />
      <p className="vnd-note" data-testid="trace-coverage">
        {shares.origin === null ? t('vnd3.lead.trace.none.text') : t('vnd3.lead.trace.text', { origin: data.trace_coverage.with_origin, files: data.trace_coverage.with_files, bids: data.trace_coverage.bids, pct: shares.origin })}
      </p>
      <p className="vnd-note">{t('vnd3.lead.trace.notRecorded.text')}</p>
    </SectionCard>
  );
}
