import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '@machvon/api-client';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, ReadonlyStat, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import '../dis.css';
import { useSnapshotLines } from '../snapshot/hooks';
import type { LinesPage, SnapshotLineView } from '../snapshot/model';
import { CoveragePill, DefinitionBadge, NONE, RatesContext, SnapshotPicker, money, rateColumns, signedVnd } from './components';
import { useFrozenSnapshots, useRates } from './hooks';
import { PAIRED_PATH, NULL_REASONS } from './model';
import type { NullReason } from './model';
import './rates.css';

type T = Translator['t'];

/** The columns a person can switch on and off; the project and the cell stay, pinned. The two rates are one column of the choice: they never come alone. */
export const COLUMNS = ['planPm', 'planLocal', 'planTotal', 'treasury', 'reported', 'ctmtqg', 'delta', 'rates', 'coverage'] as const;
export type Column = (typeof COLUMNS)[number];
const STORAGE_KEY = 'machvon.dis16.columns';

function savedColumns(tenantId: string | undefined): Column[] {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}.${tenantId ?? ''}`);
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    return Array.isArray(parsed) ? COLUMNS.filter((column) => parsed.includes(column)) : [...COLUMNS];
  } catch {
    return [...COLUMNS];
  }
}

function columnLabel(t: T, column: Column): string {
  switch (column) {
    case 'planPm':
      return t('dis.full.column.planPm');
    case 'planLocal':
      return t('dis.full.column.planLocal');
    case 'planTotal':
      return t('dis.full.column.planTotal');
    case 'treasury':
      return t('dis.full.column.treasury');
    case 'reported':
      return t('dis.full.column.reported');
    case 'ctmtqg':
      return t('dis.full.column.ctmtqg');
    case 'delta':
      return t('dis.full.column.delta');
    case 'rates':
      return t('dis.full.column.rates');
    case 'coverage':
      return t('dis.full.column.coverage');
  }
}

const reasonOf = (value: string | null): NullReason | null => NULL_REASONS.find((candidate) => candidate === value) ?? null;
const sum = (lines: readonly SnapshotLineView[], pick: (line: SnapshotLineView) => string | null): string | null =>
  lines.reduce<bigint | null>((total, line) => {
    const value = pick(line);
    return value === null ? total : (total ?? 0n) + BigInt(value);
  }, null)?.toString() ?? null;

function bucketLabel(t: T, bucket: string): string {
  return bucket === 'CURRENT_YEAR' ? t('dis.snapshot.bucket.currentYear') : bucket === 'CARRYOVER' ? t('dis.snapshot.bucket.carryover') : t('dis.snapshot.bucket.other');
}

/**
 * DIS-16: the full table of the figures of a frozen snapshot, a line for each project and cell of the report (ST-DIS-010, FR-DIS-16, FR-DIS-19). The project and the cell are pinned, the other columns are chosen
 * by the person (kept for the next visit), the two rates are one choice and come together, and the CTMTQG is a column of its own: it is part of the cell above it and never added to the total.
 */
export default function FullTableScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <FullTableContent key={tenantId ?? 'none'} route={route} />;
}

function FullTableContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  const [params, setParams] = useSearchParams();
  const frozen = useFrozenSnapshots();
  const [visible, setVisible] = useState<Column[]>(() => savedColumns(tenantId));
  const [configuring, setConfiguring] = useState(false);
  const named = params.get('snapshot') ?? '';
  // The newest frozen close figure when none is named: the server says which, the way it does for the two rates.
  const resolved = useRates({ snapshotId: named, basis: 'CURRENT_YEAR' });
  const chosen = named !== '' ? named : resolved.data?.snapshotId;
  const lines = useSnapshotLines(chosen);
  const state = useScreenState({
    isLoading: frozen.isLoading || (named === '' && resolved.isLoading) || (chosen !== undefined && lines.isLoading),
    error: frozen.error ?? lines.error ?? (named === '' && resolved.error instanceof ApiError && resolved.error.status === 404 ? undefined : resolved.error),
    data: chosen === undefined ? (resolved.isLoading ? undefined : []) : lines.data,
    isEmpty: (data) => (Array.isArray(data) ? true : (data as { pages: LinesPage[] }).pages.every((page) => page.items.length === 0)),
  });
  const items: SnapshotLineView[] = (lines.data?.pages ?? []).flatMap((page) => page.items);
  const header = lines.data?.pages[0]?.snapshot;
  const shown = (column: Column): boolean => visible.includes(column);
  const toggle = (column: Column): void => {
    const next = visible.includes(column) ? visible.filter((item) => item !== column) : COLUMNS.filter((item) => item === column || visible.includes(item));
    setVisible(next);
    try {
      window.localStorage.setItem(`${STORAGE_KEY}.${tenantId ?? ''}`, JSON.stringify(next));
    } catch {
      // The choice is kept for this visit only.
    }
  };
  const choose = (next: string): void => {
    const value = new URLSearchParams(params);
    if (next === '') value.delete('snapshot');
    else value.set('snapshot', next);
    setParams(value, { replace: true });
  };
  const totals: Record<string, ReactNode> = { reported: money(sum(items, (line) => line.reportedVnd)), ctmtqg: money(sum(items, (line) => line.ctmtqgVnd)) };
  const planGroup = t('w2dis.rates.group.plan');
  const paidGroup = t('w2dis.rates.group.disbursed');
  const columns: DataTableColumn<SnapshotLineView>[] = [
    { key: 'project', header: t('dis.snapshot.line.project'), pinned: true, render: (line) => <strong>{line.projectCode}</strong> },
    {
      key: 'cell',
      header: t('dis.snapshot.line.cell'),
      render: (line) => t('dis.snapshot.line.cell.text', { bucket: bucketLabel(t, line.bucket), level: line.budgetLevel === 'CENTRAL' ? t('dis.snapshot.level.central') : t('dis.snapshot.level.local') }),
    },
    ...(shown('planPm') ? [{ key: 'planPm', header: t('dis.snapshot.line.planPm'), group: planGroup, align: 'right' as const, render: (line: SnapshotLineView) => money(line.planPmVnd) }] : []),
    ...(shown('planLocal') ? [{ key: 'planLocal', header: t('dis.snapshot.line.planLocal'), group: planGroup, align: 'right' as const, render: (line: SnapshotLineView) => money(line.planLocalVnd) }] : []),
    ...(shown('planTotal') ? [{ key: 'planTotal', header: t('dis.full.column.planTotal'), group: planGroup, align: 'right' as const, render: (line: SnapshotLineView) => money(line.planTotalVnd) }] : []),
    ...(shown('treasury') ? [{ key: 'treasury', header: t('dis.snapshot.line.treasury'), group: paidGroup, align: 'right' as const, render: (line: SnapshotLineView) => money(line.treasuryVnd) }] : []),
    ...(shown('reported') ? [{ key: 'reported', header: t('dis.snapshot.line.reported'), group: paidGroup, align: 'right' as const, render: (line: SnapshotLineView) => <span data-col="reported">{money(line.reportedVnd)}</span> }] : []),
    ...(shown('ctmtqg') ? [{ key: 'ctmtqg', header: t('dis.full.col.ctmtqg'), group: paidGroup, align: 'right' as const, render: (line: SnapshotLineView) => <span data-col="ctmtqg">{money(line.ctmtqgVnd)}</span> }] : []),
    ...(shown('delta') ? [{ key: 'delta', header: t('dis.snapshot.line.delta'), group: paidGroup, align: 'right' as const, render: (line: SnapshotLineView) => (line.deltaVnd === null ? NONE : signedVnd(line.deltaVnd)) }] : []),
    ...(shown('rates') ? rateColumns<SnapshotLineView>(t, (line) => ({ ratePmPct: line.ratePmPct, rateTotalPct: line.rateTotalPct, reason: reasonOf(line.rateNullReason) })) : []),
    ...(shown('coverage') ? [{ key: 'coverage', header: t('dis.rates.col.coverage'), render: (line: SnapshotLineView) => <CoveragePill coverage={line.coverage === 'COMPLETE' || line.coverage === 'PARTIAL' ? line.coverage : 'NONE'} /> }] : []),
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.full.page.title')}</h1>
          <p>{t('dis.full.page.subtitle')}</p>
        </div>
        {header === undefined ? null : <DefinitionBadge definition={header.definitionStatus} />}
      </div>
      <RatesContext snapshotId={chosen} cutoff={header?.cutoffDate} />
      <FilterPanel
        unitLabel={t('dis.wr.unit')}
        applied={named === '' ? 0 : 1}
        actions={
          <button type="button" className="ui-button ui-button--outline" aria-expanded={configuring} aria-controls="full-columns" onClick={() => setConfiguring((open) => !open)}>
            {t('dis.full.columns.action')}
          </button>
        }
      >
        <div className="dis-filters">
          <SnapshotPicker id="full-snapshot" value={named} onChange={choose} snapshots={frozen.data ?? []} />
        </div>
        {configuring ? (
          <fieldset id="full-columns" className="w2dis-columns" data-testid="column-config">
            <legend>{t('dis.full.columns.legend')}</legend>
            <p className="w2dis-note">{t('dis.full.columns.hint')}</p>
            {COLUMNS.map((column) => (
              <label key={column} className="w2dis-check">
                <input type="checkbox" checked={shown(column)} onChange={() => toggle(column)} />
                {columnLabel(t, column)}
              </label>
            ))}
          </fieldset>
        ) : null}
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void lines.refetch()}>
        <div className="w2dis-stack">
          <div className="w2dis-facts" data-testid="full-totals">
            <ReadonlyStat label={t('dis.full.total.reported')} value={money(sum(items, (line) => line.reportedVnd))} />
            <ReadonlyStat label={t('dis.full.total.ctmtqg')} value={money(sum(items, (line) => line.ctmtqgVnd))} />
          </div>
          <SectionCard title={t('dis.full.table.title')} unit={t('dis.wr.unit')}>
            {header === undefined ? null : (
              <p className="w2dis-note" data-testid="full-cutoff">
                {t('dis.full.cutoff.text', { cutoff: header.cutoffDate })} · <Link to={`${PAIRED_PATH}?snapshot=${header.id}`}>{t('dis.full.link.paired')}</Link>
              </p>
            )}
            <p className="w2dis-note">{t('dis.full.total.note')}</p>
            <DataTable
              caption={t('dis.full.table.aria')}
              columns={columns}
              rows={items}
              rowKey={(line) => line.id}
              totalsLabel={t('dis.wr.totals.label')}
              totals={totals}
            />
            {lines.hasNextPage ? (
              <p className="w2dis-more">
                <button type="button" className="ui-button ui-button--outline" disabled={lines.isFetchingNextPage} onClick={() => void lines.fetchNextPage()}>
                  {t('dis.snapshot.lines.more.action')}
                </button>
              </p>
            ) : null}
          </SectionCard>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('dis.full.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
