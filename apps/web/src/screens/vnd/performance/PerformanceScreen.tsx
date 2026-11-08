import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { PostPublicationDialog } from '../risk/risk-dialogs';
import { usePerformance, usePublications } from '../risk/risk-hooks';
import { publicationClockLabel, publicationKindLabel, publicationStateLabel, ratingLabel, responseReviewLabel, suggestionLabel } from '../risk/risk-labels';
import { PUBLICATION_STATES, RISK_PERMISSION, publicationTone, responseTone } from '../risk/risk-model';
import type { ControlFigure, PerformanceLine, PerformanceView, PublicationState } from '../risk/risk-model';
import { PATHS, dayText, isUuid, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, Empty, PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';

const NONE = '–';

/**
 * VND-12, the performance of a contractor and the publication of its ratings. The worklist shows the adopted ratings by the clock of publication (six months after the contract ends, by the rule, not verified), posted or
 * not; a contractor opened from it shows its ratings with the clock of the review of its answer (the investor examines an answer and updates the rating if the answer is right), the streak of poor ratings and what it
 * suggests: a plan to remedy, then a case for the register of debarment, which a person opens in VND-03 (nothing is opened here). The posting is recorded by a person other than the one who adopted the rating.
 */
export default function PerformanceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contractor = useIdParam('contractor');
  return <PerformanceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} contractor={contractor} />;
}

function PerformanceContent({ route, contractor }: ScreenProps & { contractor: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [stateFilter, setStateFilter] = useState<PublicationState>('ALL');
  const [selected, setSelected] = useState<string | undefined>(contractor !== undefined && isUuid(contractor) ? contractor : undefined);
  const [posting, setPosting] = useState<PerformanceLine | undefined>(undefined);
  const receipt = useReceipt();
  const worklist = usePublications(stateFilter);
  const history = usePerformance(selected);
  const data = worklist.data;
  const state = useScreenState({ isLoading: worklist.isLoading, error: data === undefined ? worklist.error : undefined, data, isEmpty: () => false });
  const refreshFailed = worklist.isError && data !== undefined;
  const canPost = writer.can(RISK_PERMISSION.publish);
  const done = (): void => {
    setPosting(undefined);
    receipt.show(t('vnd.receipt.done.text', { what: t('vnd.performance.post.title'), time: vietnamStamp(new Date().toISOString()) }));
  };

  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.performance.page.title')} subtitle={t('vnd.performance.page.subtitle')} asOf={data?.as_of} stale={refreshFailed} />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void worklist.refetch()} />}
      <StateBoundary state={state} onRetry={() => void worklist.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnd.performance.section.worklist.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row" data-testid="performance-rule">
                <span>{t('vnd.performance.rule.text')}</span>
                <PolicyInfo name={t('vnd.performance.figure.rule.name')} policy={data.policy} />
              </p>
              <Figures figures={data.figures} asOf={data.as_of} unverified={data.policy.unverified} />
              <div className="vnd-filters">
                <label>
                  {t('vnd.performance.filter.state.label')}
                  <select value={stateFilter} onChange={(event) => setStateFilter(PUBLICATION_STATES.find((one) => one === event.target.value) ?? 'ALL')}>
                    {PUBLICATION_STATES.map((one) => (
                      <option key={one} value={one}>
                        {publicationStateLabel(t, one)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <LinesTable lines={data.items} canPost={canPost && !writer.readOnly} asOf={data.as_of} onOpen={(line) => setSelected(line.contractor_id)} onPost={setPosting} filtered={stateFilter !== 'ALL'} onClear={() => setStateFilter('ALL')} />
            </SectionCard>
            {selected !== undefined && <ContractorPanel query={history} canPost={canPost && !writer.readOnly} onPost={setPosting} onRetry={() => void history.refetch()} />}
          </div>
        )}
      </StateBoundary>
      {posting !== undefined && <PostPublicationDialog line={posting} onClose={() => setPosting(undefined)} onDone={done} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function Figures({ figures, asOf, unverified }: { figures: ControlFigure[]; asOf: string; unverified: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="vnd-figures" data-testid="performance-figures">
      {figures.map((figure) => {
        const published = figure.code === 'VENDOR_PERFORMANCE_PUBLISHED_IN_TIME';
        const name = published ? t('vnd.performance.figure.published.name') : t('vnd.performance.figure.response.name');
        return (
          <li key={figure.code}>
            <span>{name}</span> <strong data-testid={`figure-${figure.code}`}>{figure.denominator === 0 ? NONE : `${Math.round((figure.numerator * 1000) / figure.denominator) / 10}%`}</strong>{' '}
            <CountInfo name={name} formula={published ? t('vnd.performance.figure.published.formula') : t('vnd.performance.figure.response.formula')} source={t('vnd.performance.figure.source')} asOf={asOf} unverified={unverified} />
          </li>
        );
      })}
    </ul>
  );
}

function LinesTable({ lines, canPost, asOf, onOpen, onPost, filtered, onClear }: { lines: PerformanceLine[]; canPost: boolean; asOf: string; onOpen?: (line: PerformanceLine) => void; onPost: (line: PerformanceLine) => void; filtered?: boolean; onClear?: () => void }) {
  const { t } = useTranslation();
  return (
    <DataTable<PerformanceLine>
      caption={t('vnd.performance.table.caption')}
      rows={lines}
      rowKey={(row) => row.proposal_id}
      rowAttrs={(row) => ({ 'data-proposal-id': row.proposal_id })}
      state={lines.length === 0 ? 'empty' : 'ready'}
      emptyKind={filtered === true ? 'filtered' : 'none'}
      {...(onClear === undefined ? {} : { onClearFilters: onClear })}
      severity={(row) => (row.publication === null && row.publication_clock === 'OVERDUE' ? 'URGENT' : row.response_review === 'OVERDUE' ? 'ACTION' : null)}
      columns={[
        {
          key: 'contract',
          header: t('vnd.performance.column.contract'),
          pinned: true,
          render: (row) => (
            <span className="vnd-stack">
              <span>{row.contract_code}</span>
              <Link to={PATHS.profile(row.contractor_id)}>{row.contractor_name}</Link>
            </span>
          ),
        },
        {
          key: 'rating',
          header: t('vnd.performance.column.rating'),
          render: (row) => (
            <span className="vnd-stack">
              <span>{row.rating === null ? NONE : ratingLabel(t, row.rating)}</span>
              <span className="vnd-days">{row.score === null ? NONE : t('vnd.performance.score.text', { score: row.score })}</span>
            </span>
          ),
        },
        { key: 'ended', header: t('vnd.performance.column.ended'), render: (row) => dayText(row.ended_on) },
        {
          key: 'publication',
          header: t('vnd.performance.column.publication'),
          render: (row) =>
            row.publication_clock === null ? (
              NONE
            ) : (
              <span className="vnd-stack">
                <StatusPill tone={publicationTone(row.publication_clock)}>{publicationClockLabel(t, row.publication_clock)}</StatusPill>
                <span className="vnd-days">{row.publication === null ? t('vnd.performance.due.text', { date: dayText(row.publication_due_on ?? asOf) }) : t('vnd.performance.receipt.text', { receipt: row.publication.receipt, date: dayText(row.publication.posted_on) })}</span>
                {row.updates.length > 0 && <span className="vnd-days">{t('vnd.performance.updates.text', { count: row.updates.length, kind: publicationKindLabel(t, row.updates[row.updates.length - 1]?.kind ?? 'INITIAL') })}</span>}
              </span>
            ),
        },
        {
          key: 'response',
          header: t('vnd.performance.column.response'),
          render: (row) => (
            <span className="vnd-stack">
              <StatusPill tone={responseTone(row.response_review)}>{responseReviewLabel(t, row.response_review)}</StatusPill>
              {row.response_received_on !== null && <span className="vnd-days">{t('vnd.performance.response.text', { date: dayText(row.response_received_on) })}</span>}
            </span>
          ),
        },
        {
          key: 'actions',
          header: t('vnd.performance.column.actions'),
          render: (row) => (
            <span className="vnd-row">
              {onOpen !== undefined && (
                <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="open-history" onClick={() => onOpen(row)}>
                  {t('vnd.performance.open.action')}
                </button>
              )}
              {canPost && row.can_post && row.state === 'ADOPTED' && (
                <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="post-publication" onClick={() => onPost(row)}>
                  {row.publication === null ? t('vnd.performance.post.action') : t('vnd.performance.update.action')}
                </button>
              )}
            </span>
          ),
        },
      ]}
    />
  );
}

function ContractorPanel({ query, canPost, onPost, onRetry }: { query: ReturnType<typeof usePerformance>; canPost: boolean; onPost: (line: PerformanceLine) => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const data = query.data;
  if (query.isLoading) return <p role="status">{t('vnd.performance.panel.loading.text')}</p>;
  if (data === undefined) return <PartialNotice text={t('vnd.performance.panel.error.text')} onRetry={onRetry} testId="performance-panel-error" />;
  return (
    <SectionCard title={t('vnd.performance.panel.title', { name: data.contractor_name })} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
      <Streak view={data} />
      {data.lines.length === 0 ? <Empty text={t('vnd.performance.panel.empty.text')} testId="performance-empty" /> : <LinesTable lines={data.lines} canPost={canPost} asOf={data.as_of} onPost={onPost} />}
      <p className="vnd-note">{t('vnd.performance.panel.retrospect.text', { count: data.retrospect_proposal_ids.length })}</p>
    </SectionCard>
  );
}

function Streak({ view }: { view: PerformanceView }) {
  const { t } = useTranslation();
  if (view.suggestion === 'NONE') return <p className="vnd-note" data-testid="streak-none">{t('vnd.performance.streak.none.text', { count: view.streak })}</p>;
  return (
    <p className="callout vnd-row" role="status" data-testid="streak-banner">
      <StatusPill tone={view.suggestion === 'PROPOSE_RESTRICTION' ? 'danger' : 'warning'}>{suggestionLabel(t, view.suggestion)}</StatusPill>
      <span>{t('vnd.performance.streak.text', { count: view.streak })}</span>
      <PolicyInfo name={t('vnd.performance.figure.rule.name')} policy={view.policy} />
      {view.suggestion === 'PROPOSE_RESTRICTION' && <Link to={PATHS.cases}>{t('vnd.performance.streak.cases.link')}</Link>}
    </p>
  );
}
