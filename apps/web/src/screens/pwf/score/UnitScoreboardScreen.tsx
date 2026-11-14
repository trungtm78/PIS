import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { dayText } from '../model';
import { LineStatePill, PeriodStatusPill, RatingPill, ScoreProblemBanner, SupportNotice } from './components';
import { UnitSelect, useUnitNames } from './units';
import { useExportPeriod, usePeriodLines, usePeriods, useScoreCacheGuard, useScoreIdentity } from './hooks';
import { lineStateWord } from './labels';
import { SCORE_PERMISSIONS, boardOrder, describeScoreProblem, exportBlob, lineLink, mayDo, periodLink, rangeText, rankingBlock, scoreText, isRated } from './model';
import type { ScoreLineRow, ScorePeriod } from './model';
import '../pwf.css';
import './score.css';

const STATES = ['RATED', 'SMALL_SAMPLE', 'NOT_RATED'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PWF-12: the scoreboard of a unit for the manager (the unit at the time of the period) and for the people department (the whole tenant). It does not rank people whose samples differ. */
export default function UnitScoreboardScreen({ route }: ScreenProps) {
  const identity = useScoreIdentity();
  return <BoardContent key={identity} route={route} />;
}

function download(file: { file_name: string; content_type: string; content_base64: string }): void {
  const blob = exportBlob(file);
  if (blob === null || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.file_name;
  link.click();
  URL.revokeObjectURL(url);
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  useScoreCacheGuard();
  const mayRead = mayDo(permissions, SCORE_PERMISSIONS.readUnit) || mayDo(permissions, SCORE_PERMISSIONS.readHr);
  const mayExport = mayDo(permissions, SCORE_PERMISSIONS.export);
  const periods = usePeriods({}, mayRead);
  const all = useMemo(() => (periods.data?.pages ?? []).flatMap((page) => page.items), [periods.data]);
  const chosen = params.get('period') ?? all[0]?.id ?? null;
  const period = all.find((one) => one.id === chosen);
  const [stateFilter, setStateFilter] = useState('');
  const [unitFilter, setUnitFilter] = useState('');
  const unitValid = unitFilter.trim() === '' || UUID.test(unitFilter.trim());
  const lines = usePeriodLines(chosen, { state: stateFilter === '' ? undefined : stateFilter, unitId: unitFilter.trim() === '' || !unitValid ? undefined : unitFilter.trim().toLowerCase() }, mayRead && chosen !== null);
  const rows = useMemo(() => (lines.data?.pages ?? []).flatMap((page) => page.items), [lines.data]);
  const total = lines.data?.pages[0]?.total ?? 0;
  // The population is complete once the last page is in; until then (or while a page is on the way) no place is given.
  const complete = lines.data !== undefined && !lines.hasNextPage && !lines.isFetchingNextPage;
  const block = rankingBlock(rows, complete);
  const ordered = useMemo(() => boardOrder(rows, complete), [rows, complete]);
  const exporter = useExportPeriod();
  const [exportProblem, setExportProblem] = useState<ReturnType<typeof describeScoreProblem> | undefined>(undefined);
  const periodState = useScreenState({ isLoading: periods.isLoading, error: periods.error, data: periods.data, isEmpty: () => all.length === 0 });
  const screenState = !mayRead ? 'denied' : periodState;
  const lineState = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data, isEmpty: () => rows.length === 0 });

  const columns: DataTableColumn<{ row: ScoreLineRow; place: number | null }>[] = [
    { key: 'place', header: t('pwfs.board.col.place'), align: 'right', render: ({ place }) => (place === null ? <span aria-label={t('pwfs.board.noPlace.label')}>–</span> : <span className="pwfs-board__place">{place}</span>) },
    {
      key: 'name',
      header: t('pwfs.board.col.person'),
      render: ({ row }) => <Link to={lineLink(row.id)}>{row.display_name}</Link>,
    },
    { key: 'computed', header: t('pwfs.board.col.computed'), align: 'right', render: ({ row }) => scoreText(row.score_computed) },
    { key: 'adjusted', header: t('pwfs.board.col.adjusted'), align: 'right', render: ({ row }) => (row.has_adjustment ? scoreText(row.score_adjusted) : '–') },
    { key: 'rating', header: t('pwfs.board.col.rating'), render: ({ row }) => (isRated(row) && row.rating !== null ? <RatingPill rating={row.rating} /> : <LineStatePill state={row.state} />) },
    { key: 'sample', header: t('pwfs.board.col.sample'), align: 'right', render: ({ row }) => t('pwfs.board.sample.text', { count: row.rated_task_count, weight: row.effective_weight }) },
    {
      key: 'marks',
      header: t('pwfs.board.col.marks'),
      render: ({ row }) => (
        <span className="pwf-pills">
          {row.has_adjustment ? (
            <StatusPill tone="info" icon="±">
              {t('pwfs.board.adjusted.word')}
            </StatusPill>
          ) : null}
          {row.has_open_response ? (
            <StatusPill tone="warning" icon="◐">
              {t('pwfs.board.openResponse.word')}
            </StatusPill>
          ) : null}
        </span>
      ),
    },
  ];

  const exportPeriod = (): void => {
    if (chosen === null) return;
    setExportProblem(undefined);
    exporter.mutate(chosen, { onSuccess: download, onError: (error) => setExportProblem(describeScoreProblem(error)) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwfs.board.title.text')}</h1>
          <p>{t('pwfs.board.subtitle.text')}</p>
        </div>
      </div>
      <SupportNotice />
      <StateBoundary state={screenState} onRetry={() => void periods.refetch()}>
        <SectionCard title={t('pwfs.board.period.title')} status={period === undefined ? undefined : <PeriodStatusPill status={period.status} />}>
          <PeriodPicker periods={all} chosen={chosen} onChoose={(id) => setParams({ period: id })} />
          {period === undefined ? null : <PeriodFacts period={period} />}
          {periods.hasNextPage ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="more-periods" onClick={() => void periods.fetchNextPage()}>
              {t('pwfs.board.morePeriods.action')}
            </button>
          ) : null}
        </SectionCard>
        <SectionCard
          title={t('pwfs.board.lines.title')}
          status={<span data-testid="shown">{t('pwfs.board.shown.text', { shown: rows.length, total })}</span>}
          actions={
            mayExport ? (
              <button type="button" className="ui-button ui-button--outline" disabled={chosen === null || exporter.isPending} data-action="export" onClick={exportPeriod}>
                {t('pwfs.board.export.action')}
              </button>
            ) : undefined
          }
        >
          {exportProblem === undefined ? null : <ScoreProblemBanner problem={exportProblem} />}
          {block === null || rows.length === 0 ? null : (
            <p className="callout" role="note" data-testid="no-ranking">
              {t(block === 'partial' ? 'pwfs.board.partial.note' : 'pwfs.board.differ.note')}
            </p>
          )}
          <div className="pwf-filters">
            <div className="pwf-field">
              <label htmlFor="pwfs-filter-state">{t('pwfs.board.filter.state.label')}</label>
              <select id="pwfs-filter-state" value={stateFilter} data-testid="filter-state" onChange={(event) => setStateFilter(event.target.value)}>
                <option value="">{t('pwfs.board.filter.any.option')}</option>
                {STATES.map((one) => (
                  <option key={one} value={one}>
                    {lineStateWord(t, one)}
                  </option>
                ))}
              </select>
            </div>
            <div className="pwf-field">
              <label htmlFor="pwfs-filter-unit">{t('pwfs.board.filter.unit.label')}</label>
              <UnitSelect id="pwfs-filter-unit" value={unitFilter} invalid={!unitValid} testId="filter-unit" anyLabel={t('pwfs.board.filter.any.option')} onChange={setUnitFilter} />
              {unitValid ? null : (
                <span className="pwf-field__error" data-testid="error-unit">
                  <span aria-hidden="true">⚠ </span>
                  {t('pwfs.board.filter.unit.error')}
                </span>
              )}
            </div>
          </div>
          <StateBoundary state={lineState} onRetry={() => void lines.refetch()}>
            <div className="pwf-free">
              <DataTable columns={columns} rows={ordered} rowKey={({ row }) => row.id} caption={t('pwfs.board.caption.text')} />
            </div>
            {lines.hasNextPage ? (
              <button type="button" className="ui-button ui-button--outline" data-action="more-lines" disabled={lines.isFetchingNextPage} onClick={() => void lines.fetchNextPage()}>
                {t('pwfs.board.moreLines.action')}
              </button>
            ) : null}
          </StateBoundary>
        </SectionCard>
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

function PeriodPicker({ periods, chosen, onChoose }: { periods: readonly ScorePeriod[]; chosen: string | null; onChoose: (id: string) => void }) {
  const { t } = useTranslation();
  const unitName = useUnitNames();
  return (
    <div className="pwf-field">
      <label htmlFor="pwfs-period">{t('pwfs.board.period.label')}</label>
      <select id="pwfs-period" value={chosen ?? ''} data-testid="period" onChange={(event) => onChoose(event.target.value)}>
        {periods.map((one) => (
          <option key={one.id} value={one.id}>
            {t('pwf6.score.period.option', { range: rangeText(one.period_from, one.period_to), unit: one.scope_unit_name ?? one.scope_unit_code ?? unitName(one.scope_unit_id) })}
          </option>
        ))}
      </select>
    </div>
  );
}

function PeriodFacts({ period }: { period: ScorePeriod }) {
  const { t } = useTranslation();
  return (
    <dl className="pwf-facts" data-testid="period-facts">
      <dt>{t('pwfs.board.facts.hash.label')}</dt>
      <dd>{period.snapshot_hash === null ? t('pwfs.board.facts.noHash.text') : period.snapshot_hash.slice(0, 16)}</dd>
      <dt>{t('pwfs.board.facts.window.label')}</dt>
      <dd>{period.response_until === null ? '–' : dayText(period.response_until)}</dd>
      <dt>{t('pwfs.board.facts.manage.label')}</dt>
      <dd>
        <Link to={periodLink(period.id)}>{t('pwfs.board.facts.manage.link')}</Link>
      </dd>
    </dl>
  );
}
