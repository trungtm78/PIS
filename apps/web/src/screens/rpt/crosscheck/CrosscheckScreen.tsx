import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { HashLine } from '../components';
import { vietnamDateTime } from '../model';
import '../rpt.css';
import './crosscheck.css';
import { useCrosscheck, useExplain } from './hooks';
import { REASON_MAX, differenceText, draftFromSearch, figureText, periodFromSearch, reasonProblem, refusalOf, sortFindings, stepKey } from './model';
import type { Crosscheck, Finding, PeriodChoice, Skip } from './model';

const severityTone = (finding: Finding): Tone => (finding.status === 'EXPLAINED' ? 'success' : finding.severity === 'BLOCKING' ? 'danger' : 'warning');

/**
 * RPT-09, the reports of one period set against each other before release (ENT-4a, CN.04). The page asks the server for the comparison of the period (the reports as they stand and the frozen snapshot), says how much
 * was really compared (a gate that compared nothing says so), and lists every difference with the formula, the source and the day of each number it is made of, the steps that lead to a correction, and the form to
 * explain it. An explanation is for the figures as they are now (their fingerprint) and is refused to whoever prepared a report the difference is about. Opened from a draft, the page also says whether that draft may be issued.
 */
export default function CrosscheckScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CrosscheckContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CrosscheckContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const period = periodFromSearch(search, new Date());
  const draftId = draftFromSearch(search);
  const query = useCrosscheck(period, draftId);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const thousands = t('rpt.crosscheck.thousands');

  const choose = (next: Partial<PeriodChoice>): void => {
    const merged = { ...period, ...next };
    const max = merged.kind === 'QUARTER' ? 4 : 12;
    const params: Record<string, string> = { kind: merged.kind, year: String(merged.year), index: String(Math.min(Math.max(merged.index, 1), max)) };
    if (draftId !== undefined) params.draft = draftId;
    setSearch(params);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.crosscheck.page.title')}</h1>
          <p>{t('rpt.crosscheck.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('rpt.crosscheck.context.scope'), value: tenant?.name ?? '–' }, ...(data === undefined ? [] : [{ label: t('rpt.crosscheck.context.rule'), value: `${data.rule.code} v${data.rule.version}` }])]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={query.isError && data !== undefined} />
      <div className="rpt-cc__period">
        <label>
          {t('rpt.crosscheck.period.kind')}
          <select value={period.kind} data-testid="period-kind" onChange={(event) => choose({ kind: event.target.value === 'QUARTER' ? 'QUARTER' : 'MONTH' })}>
            <option value="MONTH">{t('rpt.crosscheck.period.month')}</option>
            <option value="QUARTER">{t('rpt.crosscheck.period.quarter')}</option>
          </select>
        </label>
        <label>
          {t('rpt.crosscheck.period.year')}
          <input type="number" min={1900} max={2999} value={period.year} data-testid="period-year" onChange={(event) => choose({ year: Number(event.target.value) })} />
        </label>
        <label>
          {t('rpt.crosscheck.period.index')}
          <input type="number" min={1} max={period.kind === 'QUARTER' ? 4 : 12} value={period.index} data-testid="period-index" onChange={(event) => choose({ index: Number(event.target.value) })} />
        </label>
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && <Body data={data} period={period} thousands={thousands} />}
      </StateBoundary>
    </section>
  );
}

function Body({ data, period, thousands }: { data: Crosscheck; period: PeriodChoice; thousands: string }) {
  const { t } = useTranslation();
  const findings = sortFindings(data.findings);
  const open = findings.filter((one) => one.status === 'OPEN');
  return (
    <>
      {data.rule.unverified ? (
        <p className="callout" role="status" data-testid="rule-unverified">
          {t('rpt.crosscheck.rule.unverified')}
        </p>
      ) : null}
      {data.gate === null || data.gate === undefined ? null : <Gate gate={data.gate} />}
      <dl className="rpt-cc__coverage" data-testid="coverage">
        <Stat label={t('rpt.crosscheck.coverage.reports')} value={`${data.coverage.usable}/${data.coverage.reports}`} />
        <Stat label={t('rpt.crosscheck.coverage.rules')} value={data.coverage.rules_run} />
        <Stat label={t('rpt.crosscheck.coverage.comparisons')} value={data.coverage.comparisons} />
        <Stat label={t('rpt.crosscheck.coverage.skipped')} value={data.coverage.skipped} />
        <Stat label={t('rpt.crosscheck.coverage.open')} value={open.length} />
      </dl>
      {data.coverage.comparisons === 0 ? (
        <p className="callout" role="status" data-testid="nothing-compared">
          {t('rpt.crosscheck.coverage.nothing')}
        </p>
      ) : null}
      <h2>{t('rpt.crosscheck.reports.title')}</h2>
      <ReportsTable data={data} />
      <h2>{t('rpt.crosscheck.findings.title')}</h2>
      {findings.length === 0 ? (
        <p data-testid="no-findings">{data.coverage.comparisons === 0 ? t('rpt.crosscheck.findings.noneCompared') : t('rpt.crosscheck.findings.none')}</p>
      ) : (
        findings.map((finding) => <FindingCard key={finding.fingerprint} finding={finding} period={period} thousands={thousands} />)
      )}
      <h2>{t('rpt.crosscheck.skipped.title')}</h2>
      <SkippedTable skipped={data.skipped} />
      <p className="rpt-muted">
        {t('rpt.crosscheck.hash')} <HashLine sha={data.sha256} />
      </p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rpt-facts__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Gate({ gate }: { gate: NonNullable<Crosscheck['gate']> }) {
  const { t } = useTranslation();
  return (
    <div className={`rpt-cc__gate ${gate.passed ? 'rpt-cc__gate--clear' : 'rpt-cc__gate--blocked'}`} role="status" data-testid="gate">
      <strong>{gate.passed ? t('rpt.crosscheck.gate.passed') : t('rpt.crosscheck.gate.blocked', { count: gate.blocking_open })}</strong>
      <p>{t('rpt.crosscheck.gate.counts', { explained: gate.blocking_explained, warnings: gate.warnings })}</p>
    </div>
  );
}

function ReportsTable({ data }: { data: Crosscheck }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Crosscheck['reports'][number]>[] = [
    { key: 'role', header: t('rpt.crosscheck.reports.col.role'), pinned: true, render: (row) => t(`rpt.crosscheck.role.${row.role.toLowerCase()}`) },
    { key: 'form', header: t('rpt.crosscheck.reports.col.form'), render: (row) => <strong>{row.layout_code}</strong> },
    { key: 'period', header: t('rpt.crosscheck.reports.col.period'), render: (row) => row.period_code },
    { key: 'ref', header: t('rpt.crosscheck.reports.col.ref'), render: (row) => (row.ref.kind === 'ISSUE' ? t('rpt.crosscheck.ref.issue', { revision: row.ref.revision ?? 1 }) : row.ref.kind === 'SNAPSHOT' ? t('rpt.crosscheck.ref.snapshot', { revision: row.ref.revision ?? 1 }) : t('rpt.crosscheck.ref.draft')) },
    { key: 'source', header: t('rpt.crosscheck.reports.col.source'), render: (row) => (row.data_source === 'ILLUSTRATIVE' ? <StatusPill tone="warning">{t('rpt.crosscheck.source.illustrative')}</StatusPill> : <StatusPill tone="info">{t('rpt.crosscheck.source.live')}</StatusPill>) },
    { key: 'figures', header: t('rpt.crosscheck.reports.col.figures'), render: (row) => (row.has_figures ? t('rpt.crosscheck.figures.yes') : t('rpt.crosscheck.figures.no')) },
    { key: 'snapshot', header: t('rpt.crosscheck.reports.col.snapshot'), render: (row) => (row.snapshot_id === null || row.snapshot_id === undefined ? '–' : t('rpt.crosscheck.snapshot.of', { revision: row.snapshot_revision ?? 0 })) },
  ];
  return <DataTable caption={t('rpt.crosscheck.reports.caption')} columns={columns} rows={data.reports} rowKey={(row) => `${row.ref.kind}:${row.ref.id}`} />;
}

function SkippedTable({ skipped }: { skipped: readonly Skip[] }) {
  const { t } = useTranslation();
  if (skipped.length === 0) return <p>{t('rpt.crosscheck.skipped.none')}</p>;
  const columns: DataTableColumn<Skip>[] = [
    { key: 'rule', header: t('rpt.crosscheck.skipped.col.rule'), pinned: true, render: (row) => row.rule_id },
    { key: 'reason', header: t('rpt.crosscheck.skipped.col.reason'), render: (row) => t(`rpt.crosscheck.skip.${row.reason.toLowerCase()}`) },
    { key: 'text', header: t('rpt.crosscheck.skipped.col.text'), render: (row) => row.text },
  ];
  return <DataTable caption={t('rpt.crosscheck.skipped.caption')} columns={columns} rows={[...skipped]} rowKey={(row) => `${row.rule_id}|${row.reason}|${row.role ?? ''}|${row.period_code ?? ''}|${row.code ?? ''}`} />;
}

function FindingCard({ finding, period, thousands }: { finding: Finding; period: PeriodChoice; thousands: string }) {
  const { t } = useTranslation();
  const explanation = finding.explanation ?? null;
  const kind = finding.status === 'EXPLAINED' ? 'explained' : finding.severity === 'BLOCKING' ? 'blocking' : 'warning';
  return (
    <article className={`rpt-cc__finding rpt-cc__finding--${kind}`} data-testid={`finding-${finding.fingerprint.slice(0, 8)}`} aria-label={`${finding.rule_id} ${finding.code}`}>
      <div className="rpt-cc__head">
        <strong>{finding.rule_id}</strong>
        <span>{finding.rule_name}</span>
        <StatusPill tone={severityTone(finding)}>{finding.status === 'EXPLAINED' ? t('rpt.crosscheck.status.explained') : finding.severity === 'BLOCKING' ? t('rpt.crosscheck.severity.blocking') : t('rpt.crosscheck.severity.warning')}</StatusPill>
        {finding.blocks_release === true ? <StatusPill tone="danger">{t('rpt.crosscheck.blocksRelease')}</StatusPill> : null}
        <code>{finding.code}</code>
        <span className="rpt-muted">{finding.period_code}</span>
      </div>
      <dl className="rpt-cc__numbers">
        <Stat label={t('rpt.crosscheck.number.expected')} value={figureText(finding.expected, finding.unit, thousands)} />
        <Stat label={t('rpt.crosscheck.number.actual')} value={figureText(finding.actual, finding.unit, thousands)} />
        <Stat label={t('rpt.crosscheck.number.difference')} value={differenceText(finding.difference, finding.unit, thousands)} />
        <Stat label={t('rpt.crosscheck.number.tolerance')} value={figureText(finding.tolerance, finding.unit, thousands)} />
      </dl>
      <p className="rpt-cc__formula" data-testid="formula">
        {finding.formula}
      </p>
      <TermsTable finding={finding} thousands={thousands} />
      {finding.units === null || finding.units === undefined ? null : (
        <p className="rpt-muted" data-testid="unit-sums">
          {t('rpt.crosscheck.units')} {finding.units.map((one) => `${one.unit}: ${figureText(one.sum, finding.unit, thousands)}`).join('; ')}
        </p>
      )}
      <div>
        <strong>{t('rpt.crosscheck.path.title')}</strong>
        <ol className="rpt-cc__path">
          {finding.path.map((step, at) => (
            <li key={`${step.step}-${at}`}>{t(stepKey(step.step), { form: step.layout_code ?? '', period: step.period_code ?? '', rows: (step.rows ?? []).join(', ') })}</li>
          ))}
        </ol>
      </div>
      {explanation !== null ? (
        <p data-testid="explanation">
          <strong>{t('rpt.crosscheck.explanation.given')}</strong> {explanation.explained_by_name ?? '–'}, {vietnamDateTime(explanation.created_at)}: {explanation.reason}
        </p>
      ) : (
        <ExplainForm finding={finding} period={period} />
      )}
    </article>
  );
}

function TermsTable({ finding, thousands }: { finding: Finding; thousands: string }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Finding['terms'][number]>[] = [
    { key: 'role', header: t('rpt.crosscheck.terms.col.role'), pinned: true, render: (row) => (row.role === 'SNAPSHOT' ? t('rpt.crosscheck.role.snapshot') : t(`rpt.crosscheck.role.${row.role.toLowerCase()}`)) },
    { key: 'form', header: t('rpt.crosscheck.terms.col.form'), render: (row) => row.layout_code },
    { key: 'period', header: t('rpt.crosscheck.terms.col.period'), render: (row) => row.period_code },
    { key: 'row', header: t('rpt.crosscheck.terms.col.row'), render: (row) => row.row_key ?? '–' },
    { key: 'value', header: t('rpt.crosscheck.terms.col.value'), render: (row) => figureText(row.value, finding.unit, thousands) },
    { key: 'source', header: t('rpt.crosscheck.terms.col.source'), render: (row) => row.source },
    { key: 'asOf', header: t('rpt.crosscheck.terms.col.asOf'), render: (row) => row.as_of ?? '–' },
  ];
  return <DataTable caption={t('rpt.crosscheck.terms.caption')} columns={columns} rows={finding.terms} rowKey={(row) => `${row.ref.kind}:${row.ref.id}:${row.period_code}:${row.code}:${row.row_key ?? ''}:${row.value ?? ''}`} />;
}

function ExplainForm({ finding, period }: { finding: Finding; period: PeriodChoice }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const explain = useExplain();
  const problem = reasonProblem(reason);
  if (finding.can_explain !== true) return <p className="rpt-muted" data-testid="cannot-explain">{t('rpt.crosscheck.explain.cannot')}</p>;
  const refusal = explain.isError ? refusalOf(explain.error) : undefined;
  const message =
    refusal === undefined
      ? undefined
      : refusal.code === 'SELF_APPROVAL_DENIED'
        ? t('rpt.crosscheck.error.self')
        : refusal.code === 'CROSSCHECK_FINDING_NOT_FOUND'
          ? t('rpt.crosscheck.error.notFound')
          : refusal.code === 'SCOPE_DENIED'
            ? t('rpt.crosscheck.error.scope')
            : t('rpt.crosscheck.error.generic');
  return (
    <form
      className="rpt-cc__form"
      data-testid="explain-form"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (problem !== undefined) return;
        explain.mutate({ period, fingerprint: finding.fingerprint, reason });
      }}
    >
      <label>
        {t('rpt.crosscheck.explain.reason')}
        <textarea className="rpt-cc__reason" value={reason} maxLength={REASON_MAX} aria-invalid={touched && problem !== undefined} data-testid="explain-reason" onChange={(event) => setReason(event.target.value)} />
      </label>
      {touched && problem !== undefined ? (
        <span className="rpt-cc__error" role="alert" data-testid="explain-problem">
          {t(`rpt.crosscheck.explain.problem.${problem}`)}
        </span>
      ) : null}
      {message === undefined ? null : (
        <span className="rpt-cc__error" role="alert" data-testid="explain-error">
          {message}
        </span>
      )}
      <button type="submit" className="ui-button" disabled={explain.isPending} data-testid="explain-submit">
        {t('rpt.crosscheck.explain.submit')}
      </button>
    </form>
  );
}
