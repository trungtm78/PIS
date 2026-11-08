import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { PATHS, dayText, isUuid, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, CursorPager, Empty, PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { AssessDialog, DecideDialog } from './risk-dialogs';
import { useRiskGrade, useRiskRegister } from './risk-hooks';
import { factorFormula, factorLabel, riskStateLabel, tierLabel } from './risk-labels';
import { RISK_PERMISSION, RISK_TIERS, factorWidth, mainFactors, readingText, tierIcon, tierTone } from './risk-model';
import type { ControlFigure, RiskAssessment, RiskGrade, RiskRegisterItem, RiskTier } from './risk-model';

const NONE = '–';
const PAGE = 25;

type Dialog = { kind: 'assess' } | { kind: 'decide'; assessment: RiskAssessment };

/**
 * VND-11, the risk grade of a contractor. The register lists the grade in force, the score, the day it is looked at again and the grade that waits for its decision. A contractor opened from it shows the grade it would
 * have today, factor by factor (the points, the most a factor can add, the reading it came from, the main reason), the grade that waits and the history. A grade is a proposal until somebody confirms it, and a high grade
 * needs a second person. The weights and the cut points are the rule VENDOR_RISK (not verified); the grade does not decide whether a contractor may bid.
 */
export default function RiskScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contractor = useIdParam('contractor');
  return <RiskContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} contractor={contractor} />;
}

function RiskContent({ route, contractor }: ScreenProps & { contractor: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<RiskTier | ''>('');
  const [reviewDue, setReviewDue] = useState(false);
  const [pending, setPending] = useState(false);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<string | undefined>(contractor !== undefined && isUuid(contractor) ? contractor : undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const register = useRiskRegister({ q, tier, reviewDue, pending, cursor: cursors[cursors.length - 1], limit: PAGE });
  const grade = useRiskGrade(selected);
  const data = register.data;
  const state = useScreenState({ isLoading: register.isLoading, error: data === undefined ? register.error : undefined, data, isEmpty: () => false });
  const refreshFailed = register.isError && data !== undefined;
  const filtered = q !== '' || tier !== '' || reviewDue || pending;
  const reset = (): void => setCursors([undefined]);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };

  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.risk.page.title')} subtitle={t('vnd.risk.page.subtitle')} asOf={data?.as_of} stale={refreshFailed} />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void register.refetch()} />}
      <StateBoundary state={state} onRetry={() => void register.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnd.risk.section.register.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row" data-testid="risk-rule">
                <span>{t('vnd.risk.rule.text')}</span>
                <PolicyInfo name={t('vnd.risk.figure.rule.name')} policy={data.policy} />
              </p>
              <Figures figures={data.figures} asOf={data.as_of} unverified={data.policy.unverified} />
              <div className="vnd-filters">
                <label>
                  {t('vnd.risk.filter.q.label')}
                  <input
                    type="search"
                    value={q}
                    onChange={(event) => {
                      setQ(event.target.value);
                      reset();
                    }}
                  />
                </label>
                <label>
                  {t('vnd.risk.filter.tier.label')}
                  <select
                    value={tier}
                    onChange={(event) => {
                      setTier(RISK_TIERS.find((one) => one === event.target.value) ?? '');
                      reset();
                    }}
                  >
                    <option value="">{t('vnd.register.filter.any.option')}</option>
                    {RISK_TIERS.map((one) => (
                      <option key={one} value={one}>
                        {tierLabel(t, one)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={reviewDue}
                    onChange={(event) => {
                      setReviewDue(event.target.checked);
                      reset();
                    }}
                  />{' '}
                  {t('vnd.risk.filter.reviewDue.label')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={pending}
                    onChange={(event) => {
                      setPending(event.target.checked);
                      reset();
                    }}
                  />{' '}
                  {t('vnd.risk.filter.pending.label')}
                </label>
              </div>
              <DataTable<RiskRegisterItem>
                caption={t('vnd.risk.table.caption')}
                rows={data.items}
                rowKey={(row) => row.contractor_id}
                rowAttrs={(row) => ({ 'data-contractor-id': row.contractor_id, 'data-selected': row.contractor_id === selected ? 'true' : 'false' })}
                state={data.items.length === 0 ? 'empty' : 'ready'}
                emptyKind={filtered ? 'filtered' : 'none'}
                onClearFilters={() => {
                  setQ('');
                  setTier('');
                  setReviewDue(false);
                  setPending(false);
                  reset();
                }}
                severity={(row) => (row.tier === 'CRITICAL' ? 'URGENT' : row.review_overdue || row.pending_assessment_id !== null ? 'ACTION' : null)}
                columns={[
                  {
                    key: 'contractor',
                    header: t('vnd.risk.column.contractor'),
                    pinned: true,
                    render: (row) => (
                      <span className="vnd-stack">
                        <Link to={PATHS.profile(row.contractor_id)}>{row.legal_name}</Link>
                        <span className="vnd-days">{row.tax_identifier}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'tier',
                    header: t('vnd.risk.column.tier'),
                    render: (row) => (row.tier === null ? <span className="vnd-days">{t('vnd.risk.tier.none.text')}</span> : <StatusPill tone={tierTone(row.tier)} icon={tierIcon(row.tier)}>{tierLabel(t, row.tier)}</StatusPill>),
                  },
                  { key: 'score', header: t('vnd.risk.column.score'), align: 'right', render: (row) => (row.score === null ? NONE : String(row.score)) },
                  {
                    key: 'review',
                    header: t('vnd.risk.column.review'),
                    render: (row) =>
                      row.next_review_on === null ? (
                        NONE
                      ) : (
                        <span className="vnd-stack">
                          <span>{dayText(row.next_review_on)}</span>
                          {row.review_overdue && <StatusPill tone="danger">{t('vnd.risk.review.overdue.badge')}</StatusPill>}
                        </span>
                      ),
                  },
                  {
                    key: 'pending',
                    header: t('vnd.risk.column.pending'),
                    render: (row) => (row.pending_tier === null ? NONE : <StatusPill tone="info">{t('vnd.risk.pending.text', { tier: tierLabel(t, row.pending_tier) })}</StatusPill>),
                  },
                  {
                    key: 'actions',
                    header: t('vnd.risk.column.actions'),
                    render: (row) => (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="open-grade" onClick={() => setSelected(row.contractor_id)}>
                        {t('vnd.risk.open.action')}
                      </button>
                    ),
                  },
                ]}
              />
              <CursorPager page={cursors.length - 1} hasNext={data.next_cursor !== null} onPrev={() => setCursors((list) => list.slice(0, -1))} onNext={() => data.next_cursor !== null && setCursors((list) => [...list, data.next_cursor ?? undefined])} />
            </SectionCard>
            {selected !== undefined && (
              <ContractorPanel
                query={grade}
                canAssess={writer.can(RISK_PERMISSION.assess)}
                onAssess={() => setDialog({ kind: 'assess' })}
                onDecide={(assessment) => setDialog({ kind: 'decide', assessment })}
                onRetry={() => void grade.refetch()}
              />
            )}
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'assess' && selected !== undefined && grade.data !== undefined && (
        <AssessDialog contractorId={selected} contractorName={grade.data.contractor_name} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.risk.assess.title'))} />
      )}
      {dialog?.kind === 'decide' && <DecideDialog assessment={dialog.assessment} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.risk.decide.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function Figures({ figures, asOf, unverified }: { figures: ControlFigure[]; asOf: string; unverified: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="vnd-figures" data-testid="risk-figures">
      {figures.map((figure) => (
        <li key={figure.code}>
          <span>{figure.code === 'VENDOR_HIGH_RISK_CONTRACTORS' ? t('vnd.risk.figure.high.name') : t('vnd.risk.figure.review.name')}</span>{' '}
          <strong data-testid={`figure-${figure.code}`}>{figure.code === 'VENDOR_HIGH_RISK_CONTRACTORS' ? String(figure.numerator) : figure.denominator === 0 ? NONE : `${Math.round((figure.numerator * 1000) / figure.denominator) / 10}%`}</strong>{' '}
          <CountInfo
            name={figure.code === 'VENDOR_HIGH_RISK_CONTRACTORS' ? t('vnd.risk.figure.high.name') : t('vnd.risk.figure.review.name')}
            formula={figure.code === 'VENDOR_HIGH_RISK_CONTRACTORS' ? t('vnd.risk.figure.high.formula') : t('vnd.risk.figure.review.formula')}
            source={t('vnd.risk.figure.source')}
            asOf={asOf}
            unverified={unverified}
          />
        </li>
      ))}
    </ul>
  );
}

function ContractorPanel({ query, canAssess, onAssess, onDecide, onRetry }: { query: ReturnType<typeof useRiskGrade>; canAssess: boolean; onAssess: () => void; onDecide: (assessment: RiskAssessment) => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const data = query.data;
  if (query.isLoading) return <p role="status">{t('vnd.risk.panel.loading.text')}</p>;
  if (data === undefined) return <PartialNotice text={t('vnd.risk.panel.error.text')} onRetry={onRetry} testId="risk-panel-error" />;
  return (
    <SectionCard
      title={t('vnd.risk.panel.title', { name: data.contractor_name })}
      status={data.policy.unverified ? <UnverifiedPill /> : undefined}
      actions={
        canAssess && data.pending === null ? (
          <button type="button" className="ui-button ui-button--primary" data-testid="assess-risk" onClick={onAssess}>
            {t('vnd.risk.assess.action')}
          </button>
        ) : undefined
      }
    >
      <GradeSummary grade={data} onDecide={onDecide} />
      <Explanation grade={data} />
      <History grade={data} />
    </SectionCard>
  );
}

function GradeSummary({ grade, onDecide }: { grade: RiskGrade; onDecide: (assessment: RiskAssessment) => void }) {
  const { t } = useTranslation();
  const pending = grade.pending;
  return (
    <div className="vnd-page" data-testid="grade-summary">
      <p className="vnd-row">
        <span>{t('vnd.risk.panel.current.label')}</span>
        {grade.tier === null ? <span className="vnd-days">{t('vnd.risk.tier.none.text')}</span> : <StatusPill tone={tierTone(grade.tier)} icon={tierIcon(grade.tier)}>{tierLabel(t, grade.tier)}</StatusPill>}
        {grade.confirmed !== null && <span className="vnd-days">{t('vnd.risk.panel.confirmed.text', { review: dayText(grade.confirmed.next_review_on), name: grade.confirmed.decided_by_name ?? NONE })}</span>}
      </p>
      {pending !== null && (
        <p className="callout vnd-row" role="status" data-testid="pending-grade">
          <span>{t('vnd.risk.panel.pending.text', { tier: tierLabel(t, pending.tier), score: pending.score, name: pending.assessed_by_name ?? NONE })}</span>
          {pending.dual_check && <StatusPill tone="warning">{t('vnd.risk.panel.dual.badge')}</StatusPill>}
          {pending.can_decide ? (
            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="decide-risk" onClick={() => onDecide(pending)}>
              {t('vnd.risk.decide.action')}
            </button>
          ) : (
            <span className="vnd-days" data-testid="cannot-decide">
              {pending.dual_check ? t('vnd.risk.panel.cannotDual.text') : t('vnd.risk.panel.cannot.text')}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function Explanation({ grade }: { grade: RiskGrade }) {
  const { t } = useTranslation();
  const live = grade.live;
  const main = mainFactors(live.factors)[0];
  return (
    <div data-testid="explanation">
      <p className="vnd-row">
        <strong>{t('vnd.risk.live.title')}</strong>
        <StatusPill tone={tierTone(live.tier)} icon={tierIcon(live.tier)}>
          {tierLabel(t, live.tier)}
        </StatusPill>
        <span data-testid="live-score">{t('vnd.risk.live.score.text', { score: live.score })}</span>
        <PolicyInfo name={t('vnd.risk.figure.rule.name')} policy={grade.policy} />
        {live.floored && <StatusPill tone="warning">{t('vnd.risk.live.floored.badge', { tier: tierLabel(t, live.score_tier) })}</StatusPill>}
      </p>
      {main === undefined ? <Empty text={t('vnd.risk.live.none.text')} testId="no-reason" /> : <p data-testid="main-reason">{t('vnd.risk.live.main.text', { factor: factorLabel(t, main.factor), points: main.points })}</p>}
      <DataTable<RiskGrade['live']['factors'][number]>
        caption={t('vnd.risk.factors.caption')}
        rows={live.factors}
        rowKey={(row) => row.factor}
        rowAttrs={(row) => ({ 'data-factor': row.factor })}
        state="ready"
        columns={[
          { key: 'factor', header: t('vnd.risk.factors.column.factor'), pinned: true, render: (row) => <span>{factorLabel(t, row.factor)} <InfoFor factor={row.factor} grade={grade} /></span> },
          {
            key: 'points',
            header: t('vnd.risk.factors.column.points'),
            render: (row) => (
              <span className="vnd-coverage">
                <span className="vnd-bar" aria-hidden="true">
                  <span className="vnd-bar__fill" style={{ width: `${factorWidth(row)}%` }} />
                </span>
                <span className="vnd-coverage__pct">{t('vnd.risk.factors.points.text', { points: row.points, max: row.max })}</span>
              </span>
            ),
          },
          { key: 'reading', header: t('vnd.risk.factors.column.reading'), render: (row) => <span className="vnd-days">{readingText(row.reading)}</span> },
        ]}
      />
      <p className="vnd-note">{t('vnd.risk.live.review.text', { months: live.review_months, date: dayText(live.next_review_on), dual: live.dual_check ? t('vnd.risk.live.dual.yes') : t('vnd.risk.live.dual.no') })}</p>
    </div>
  );
}

function InfoFor({ factor, grade }: { factor: string; grade: RiskGrade }) {
  const { t } = useTranslation();
  return <CountInfo name={factorLabel(t, factor)} formula={factorFormula(t, factor)} source={grade.policy.source} asOf={grade.policy.as_of} unverified={grade.policy.unverified} />;
}

function History({ grade }: { grade: RiskGrade }) {
  const { t } = useTranslation();
  return (
    <div>
      <h3>{t('vnd.risk.history.title')}</h3>
      <DataTable<RiskAssessment>
        caption={t('vnd.risk.history.caption')}
        rows={grade.history}
        rowKey={(row) => row.id}
        state={grade.history.length === 0 ? 'empty' : 'ready'}
        emptyKind="none"
        columns={[
          { key: 'tier', header: t('vnd.risk.column.tier'), render: (row) => <StatusPill tone={tierTone(row.tier)} icon={tierIcon(row.tier)}>{tierLabel(t, row.tier)}</StatusPill> },
          { key: 'score', header: t('vnd.risk.column.score'), align: 'right', render: (row) => String(row.score) },
          { key: 'state', header: t('vnd.risk.history.column.state'), render: (row) => riskStateLabel(t, row.state) },
          { key: 'assessed', header: t('vnd.risk.history.column.assessed'), render: (row) => t('vnd.risk.history.assessed.text', { name: row.assessed_by_name ?? NONE, time: vietnamStamp(row.assessed_at) }) },
          { key: 'decided', header: t('vnd.risk.history.column.decided'), render: (row) => (row.decided_at === null ? NONE : t('vnd.risk.history.assessed.text', { name: row.decided_by_name ?? NONE, time: vietnamStamp(row.decided_at) })) },
          { key: 'rule', header: t('vnd.risk.history.column.rule'), render: (row) => <span className="vnd-days">{row.rule_version}{row.rule_unverified ? ` · ${t('vnd.flag.unverified.badge')}` : ''}</span> },
        ]}
      />
    </div>
  );
}
