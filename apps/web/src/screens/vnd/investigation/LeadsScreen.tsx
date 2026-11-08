import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import { ContractorLink, CountInfo, CursorPager, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useReceipt, useWriter } from '../shared/vnd-ui';
import { errorText } from '../shared/vnd-labels';
import { isUuid } from '../shared/vnd-model';
import { useInvestigationFigures, useLeads, useVendorCommand } from './investigation-hooks';
import { leadKindLabel, leadStatusLabel } from './investigation-labels';
import { INV_PATHS, INV_PERMISSION, LEAD_KINDS, LEAD_STATUSES, PAGE_SIZE, dayText, leadOpen, leadTone, numberText, percentText, rankTone, traceShares, vietnamStamp } from './investigation-model';
import type { InvestigationFigures, LeadLine } from './investigation-model';
import './investigation.css';

interface Filters {
  status: string;
  kind: string;
  contractor: string;
}

const NO_FILTERS: Filters = { status: '', kind: '', contractor: '' };
const applied = (filters: Filters): number => [filters.status !== '', filters.kind !== '', filters.contractor.trim() !== ''].filter(Boolean).length;
const hiddenError = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * VND-13, the leads of the investigation of contractors (V6), for the auditors only. A lead is a signal for review, never a conclusion (the notice is always on the page): the links of related parties and the signs of bid
 * rigging, ranked so that the auditors look where the signals pile up. A person who is not an auditor, or who took part in the packages a lead is about, never sees it or a count that includes it: the page says the scope is
 * hidden and names nothing. The strip on top is the indicators of the investigation; the button starts a scan.
 */
export default function LeadsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <LeadsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LeadsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const writer = useWriter();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const page = cursors.length - 1;
  const query = useLeads({ ...filters, contractor: isUuid(filters.contractor) ? filters.contractor.trim() : '', cursor: cursors[page], limit: PAGE_SIZE });
  const figures = useInvestigationFigures();
  const scan = useVendorCommand('runVendorLinkScan');
  const receipt = useReceipt();
  const [scanFailure, setScanFailure] = useState<unknown>(undefined);
  const data = query.data;
  const hidden = data === undefined && hiddenError(query.error);
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined && !hidden ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const badContractor = draft.contractor.trim() !== '' && !isUuid(draft.contractor);

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    if (badContractor) return;
    setCursors([undefined]);
    setFilters(draft);
  };
  const clear = (): void => {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
    setCursors([undefined]);
  };
  const runScan = (): void => {
    setScanFailure(undefined);
    scan.mutateAsync({ body: {} }).then(
      () => receipt.show(t('vnd3.leads.scan.receipt', { time: vietnamStamp(new Date().toISOString()) })),
      (error: unknown) => setScanFailure(error),
    );
  };

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd3.leads.page.title')}
        subtitle={t('vnd3.leads.page.subtitle')}
        asOf={data?.as_of}
        stale={refreshFailed}
        actions={
          writer.can(INV_PERMISSION.leadScan) ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="run-scan" disabled={scan.isPending} onClick={runScan}>
              {scan.isPending ? t('vnd3.leads.scan.pending') : t('vnd3.leads.scan.action')}
            </button>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {scanFailure !== undefined && (
        <p className="callout" role="alert" data-testid="scan-error">
          {errorText(t, scanFailure)}
        </p>
      )}
      <p className="callout inv-notice" data-testid="signal-notice">
        {t('vnd3.leads.notice.text')}
      </p>
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      {hidden ? (
        <p className="callout" role="alert" data-testid="leads-hidden">
          {t('vnd3.leads.hidden.text')}
        </p>
      ) : (
        <>
          <FigureStrip figures={figures.data} loading={figures.isLoading} failed={figures.isError} onRetry={() => void figures.refetch()} />
          <FilterPanel applied={applied(filters)} {...(data === undefined ? {} : { updatedAt: dayText(data.as_of) })}>
            <form className="vnd-filters" onSubmit={apply} aria-label={t('vnd3.leads.filters.label')}>
              <label>
                {t('vnd3.leads.filter.status.label')}
                <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
                  <option value="">{t('vnd.register.filter.any.option')}</option>
                  {LEAD_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {leadStatusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('vnd3.leads.filter.kind.label')}
                <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
                  <option value="">{t('vnd.register.filter.any.option')}</option>
                  {LEAD_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {leadKindLabel(t, kind)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('vnd3.leads.filter.contractor.label')}
                <input type="text" value={draft.contractor} aria-invalid={badContractor} onChange={(event) => setDraft({ ...draft, contractor: event.target.value })} />
              </label>
              <span className="vnd-row">
                <button type="submit" className="ui-button ui-button--primary" disabled={badContractor}>
                  {t('vnd.register.filter.apply.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline" onClick={clear}>
                  {t('vnd.register.filter.clear.action')}
                </button>
              </span>
            </form>
          </FilterPanel>
          <StateBoundary state={state} onRetry={() => void query.refetch()}>
            {data !== undefined && (
              <SectionCard title={t('vnd3.leads.section.title')} status={data.policies.investigation.unverified ? <UnverifiedPill /> : undefined}>
                <ul className="inv-counts" data-testid="lead-counts" aria-label={t('vnd3.leads.counts.label')}>
                  {LEAD_STATUSES.map((status) => (
                    <li key={status}>
                      <StatusPill tone={leadTone(status)}>{leadStatusLabel(t, status)}</StatusPill>
                      <strong data-testid={`count-${status}`}>{numberText(countOf(data.counts, status), locale)}</strong>
                    </li>
                  ))}
                  <li>
                    <PolicyInfo name={t('vnd3.leads.rule.name')} policy={data.policies.investigation} />
                  </li>
                </ul>
                <DataTable<LeadLine>
                  caption={t('vnd3.leads.table.caption')}
                  rows={data.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-lead-id': row.id })}
                  state={data.items.length === 0 ? 'empty' : 'ready'}
                  emptyKind={applied(filters) > 0 ? 'filtered' : 'none'}
                  onClearFilters={clear}
                  severity={(row) => (leadOpen(row.status) && row.rank >= 80 ? 'ACTION' : leadOpen(row.status) && row.status === 'NEW' ? 'WATCH' : null)}
                  columns={[
                    {
                      key: 'rank',
                      header: t('vnd3.leads.column.rank'),
                      align: 'right',
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <strong className="inv-rank" data-testid={`rank-${row.id}`}>
                            {row.rank}
                          </strong>
                          <StatusPill tone={rankTone(row.rank)}>{t('vnd3.leads.rank.badge')}</StatusPill>
                        </span>
                      ),
                    },
                    {
                      key: 'kind',
                      header: t('vnd3.leads.column.kind'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <Link to={INV_PATHS.lead(row.id)}>{leadKindLabel(t, row.kind)}</Link>
                          <span className="vnd-days">{t('vnd3.leads.evidence.text', { count: row.evidence_kinds.length })}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'contractors',
                      header: t('vnd3.leads.column.contractors'),
                      render: (row) => (
                        <ul className="vnd-list">
                          {row.contractor_ids.map((id, index) => (
                            <li key={id}>
                              <ContractorLink id={id} name={row.contractor_names[index] ?? id.slice(0, 8)} />
                            </li>
                          ))}
                        </ul>
                      ),
                    },
                    { key: 'packages', header: t('vnd3.leads.column.packages'), render: (row) => (row.package_codes.length === 0 ? '–' : row.package_codes.join(', ')) },
                    { key: 'status', header: t('vnd3.leads.column.status'), render: (row) => <StatusPill tone={leadTone(row.status)}>{leadStatusLabel(t, row.status)}</StatusPill> },
                    {
                      key: 'since',
                      header: t('vnd3.leads.column.since'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{dayText(row.first_flagged_at)}</span>
                          {row.reopened_count > 0 && <span className="vnd-days">{t('vnd3.leads.reopened.text', { count: row.reopened_count })}</span>}
                        </span>
                      ),
                    },
                    { key: 'reviewer', header: t('vnd3.leads.column.reviewer'), render: (row) => row.reviewer_name ?? '–' },
                  ]}
                />
                <CursorPager page={page} hasNext={data.next_cursor !== null} onPrev={() => setCursors((current) => current.slice(0, -1))} onNext={() => data.next_cursor !== null && setCursors((current) => [...current, data.next_cursor ?? undefined])} />
              </SectionCard>
            )}
          </StateBoundary>
        </>
      )}
      <ScreenFooter route={route} />
    </Screen>
  );
}

const countOf = (counts: { new: number; in_review: number; dismiss_proposed: number; dismissed: number; confirmed: number; referred: number }, status: string): number => {
  switch (status) {
    case 'NEW':
      return counts.new;
    case 'IN_REVIEW':
      return counts.in_review;
    case 'DISMISS_PROPOSED':
      return counts.dismiss_proposed;
    case 'DISMISSED':
      return counts.dismissed;
    case 'CONFIRMED':
      return counts.confirmed;
    default:
      return counts.referred;
  }
};

/** The definition of an indicator the answer carries (the register of indicators is the source of its formula, its source and its flag), else the screen's own words. */
function Definition({ figures, code, name, formula, source }: { figures: InvestigationFigures; code: string; name: string; formula: string; source: string }) {
  const found = figures.indicators.find((indicator) => indicator.code === code);
  return <CountInfo name={found?.name ?? name} formula={found?.formula ?? formula} source={found?.source ?? source} asOf={figures.as_of} unverified={found?.unverified ?? true} />;
}

function FigureStrip({ figures, loading, failed, onRetry }: { figures: InvestigationFigures | undefined; loading: boolean; failed: boolean; onRetry: () => void }) {
  const { t, locale } = useTranslation();
  const state = figures !== undefined ? 'ready' : loading || !failed ? 'loading' : 'error';
  const f = figures;
  const shares = f === undefined ? undefined : traceShares(f.trace);
  return (
    <KpiStrip label={t('vnd3.leads.figures.label')}>
      <KpiTile
        label={t('vnd3.leads.figure.open.name')}
        value={f === undefined ? '' : numberText(f.leads.open, locale)}
        state={state}
        onRetry={onRetry}
        sub={
          f === undefined ? undefined : (
            <span className="vnd-row" data-testid="figure-open">
              <span>{t('vnd3.leads.figure.open.sub', { new: f.leads.new })}</span>
              <Definition figures={f} code="VENDOR_LEADS_OPEN" name={t('vnd3.leads.figure.open.name')} formula={t('vnd3.leads.figure.open.formula')} source={t('vnd3.leads.figure.source')} />
            </span>
          )
        }
      />
      <KpiTile
        label={t('vnd3.leads.figure.precision.name')}
        value={f === undefined ? '' : percentText(f.leads.precision_pct, locale)}
        state={state}
        onRetry={onRetry}
        sub={
          f === undefined ? undefined : (
            <span className="vnd-row" data-testid="figure-precision">
              <span>{t('vnd3.leads.figure.precision.sub', { right: f.leads.confirmed + f.leads.referred, decided: f.leads.confirmed + f.leads.referred + f.leads.dismissed })}</span>
              <Definition figures={f} code="VENDOR_LEAD_PRECISION" name={t('vnd3.leads.figure.precision.name')} formula={t('vnd3.leads.figure.precision.formula')} source={t('vnd3.leads.figure.source')} />
            </span>
          )
        }
      />
      <KpiTile
        label={t('vnd3.leads.figure.trace.name')}
        value={shares === undefined || shares.origin === null ? (f === undefined ? '' : '–') : percentText(shares.origin, locale)}
        state={state}
        onRetry={onRetry}
        tone={shares !== undefined && shares.origin !== null && shares.origin < 50 ? 'warning' : 'default'}
        sub={
          f === undefined ? undefined : (
            <span className="vnd-row" data-testid="figure-trace">
              <span>{t('vnd3.leads.figure.trace.sub', { origin: f.trace.with_origin, files: f.trace.with_files, bids: f.trace.bids })}</span>
              <CountInfo name={t('vnd3.leads.figure.trace.name')} formula={t('vnd3.leads.figure.trace.formula')} source={t('vnd3.leads.figure.trace.source')} asOf={f.as_of} />
            </span>
          )
        }
      />
      <KpiTile
        label={t('vnd3.leads.figure.scan.name')}
        value={f === undefined ? '' : f.last_scan.finished_at === null ? t('vnd3.leads.figure.scan.never') : dayText(f.last_scan.finished_at)}
        state={state}
        onRetry={onRetry}
        tone={f !== undefined && f.last_scan.finished_at === null ? 'warning' : 'default'}
        sub={
          f === undefined ? undefined : (
            <span className="vnd-row" data-testid="figure-scan">
              <span>{f.last_scan.finished_at === null ? t('vnd3.leads.figure.scan.neverSub') : t('vnd3.leads.figure.scan.sub', { links: f.last_scan.links, clusters: f.last_scan.clusters, fresh: f.last_scan.leads_new })}</span>
              <CountInfo name={t('vnd3.leads.figure.scan.name')} formula={t('vnd3.leads.figure.scan.formula')} source={t('vnd3.leads.figure.trace.source')} asOf={f.as_of} />
            </span>
          )
        }
      />
    </KpiStrip>
  );
}
