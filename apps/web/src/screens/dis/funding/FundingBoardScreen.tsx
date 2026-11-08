import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Field } from '../components';
import '../dis.css';
import { Banner, FigureInfo, RateTile } from './components';
import { useBoard, useTaxonomy } from './hooks';
import { BATCH_PATH, BOARD_COLUMNS, GRAINS, HISTORY_PATH, NONE, VIEWS, money, moneyOf, ordinalsOf, ratesOverall, sharesOf, todayOf, camel } from './model';
import type { BoardProject, Cell, Grain, Money, View } from './model';
import './funding.css';

interface Row {
  key: string;
  project: BoardProject;
  cell: Cell;
}

/**
 * DIS-27: the figures of the funding model for a period and the indicators made from them (FND-1, docs/fnd-funding-model.md sections 5 and 8): the plan of the year as first approved and as adjusted, the plan of the
 * period, the estimate, the actual, the cumulative from the start of the year and from the start of the project, and the ratios of the pack of the tenant (each tile with its numerator and denominator). Every number carries the
 * "i" (formula, source, the day it is as of, the pack and its version); a figure nobody has is a dash and never zero; a rate of a group is the sum of the parts over the sum of the plans, never the mean of the rates.
 */
export default function FundingBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [params, setParams] = useSearchParams();
  const taxonomy = useTaxonomy();
  const today = todayOf();
  const grain: Grain = (GRAINS as readonly string[]).includes(params.get('grain') ?? '') ? (params.get('grain') as Grain) : 'MONTH';
  const planYear = Number(params.get('year') ?? today.slice(0, 4));
  const defaultOrdinal = grain === 'YEAR' ? 0 : grain === 'QUARTER' ? Math.ceil(Number(today.slice(5, 7)) / 3) : Number(today.slice(5, 7));
  const ordinal = Number(params.get('ordinal') ?? defaultOrdinal);
  const view: View = params.get('view') === 'RESTATED' ? 'RESTATED' : 'AS_REPORTED';
  const asOf = params.get('asOf') ?? today;
  const measure = params.get('measure') ?? taxonomy.data?.measures[0] ?? 'DISBURSED';
  const projectId = params.get('project') ?? undefined;
  const board = useBoard(taxonomy.data === undefined ? undefined : { planYear, grain, ordinal: ordinals(grain).includes(ordinal) ? ordinal : defaultOrdinal, measure, view, asOf, ...(projectId === undefined ? {} : { projectId }) });
  const state = useScreenState({ isLoading: taxonomy.isLoading || board.isLoading, error: taxonomy.error ?? board.error, data: board.data, isEmpty: (data) => (data as { projects: unknown[] }).projects.length === 0 });
  const frozen = mode === 'READ_ONLY';
  const set = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    if (key === 'grain') next.delete('ordinal');
    setParams(next, { replace: true });
  };
  const data = board.data;
  const version = data?.version ?? 0;
  const unverified = data?.unverified ?? false;
  const rows: Row[] = data?.projects.flatMap((project) => project.cells.filter((cell) => hasFigures(cell)).map((cell) => ({ key: `${project.project_id}/${cell.class_code}/${cell.tier_code}`, project, cell }))) ?? [];
  const columns: DataTableColumn<Row>[] = [
    { key: 'project', header: t('dis.funding.col.project'), pinned: true, render: (row) => <span title={row.project.project_name}>{row.project.project_code}</span> },
    { key: 'class', header: t('dis.funding.col.class'), render: (row) => classLabel(taxonomy.data?.classes, row.cell.class_code) },
    ...BOARD_COLUMNS.map((column) => ({
      key: column.key,
      header: t(`dis.funding.figure.${camel(column.code)}`),
      align: 'right' as const,
      render: (row: Row) => <Figure value={row.cell[column.key]} flash={column.code === 'ACTUAL' && row.cell.actual_flash} gaps={column.code === 'CUMULATIVE_YTD' ? row.cell.gap_months : []} />,
    })),
    {
      key: 'links',
      header: t('dis.funding.col.links'),
      render: (row) => (
        <Link to={`${HISTORY_PATH}?project=${row.project.project_id}&class=${row.cell.class_code}&tier=${row.cell.tier_code}&measure=${data?.measure ?? measure}&grain=${grain === 'YEAR' ? 'MONTH' : grain}&year=${planYear}&ordinal=${ordinal === 0 ? 1 : ordinal}`}>{t('dis.funding.row.history')}</Link>
      ),
    },
  ];
  const headerInfo = (code: string, source: string): JSX.Element | null =>
    data === undefined ? null : <FigureInfo code={code} asOf={data.as_of} packCode={data.pack_code} version={version} unverified={unverified} source={source} />;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.funding.board.title')}</h1>
          <p>{t('dis.funding.board.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={BATCH_PATH}>
          {t('dis.funding.board.toBatches')}
        </Link>
      </div>
      <FilterPanel applied={[params.get('year'), params.get('grain'), params.get('ordinal'), params.get('view'), params.get('asOf'), params.get('measure'), params.get('project')].filter((one) => one !== null).length}>
        <Field id="fnd-year" label={t('dis.funding.filter.year')} error={undefined}>
          <input id="fnd-year" type="number" min={1990} max={2100} value={planYear} onChange={(event) => set('year', event.target.value)} />
        </Field>
        <Field id="fnd-grain" label={t('dis.funding.filter.grain')} error={undefined}>
          <select id="fnd-grain" value={grain} onChange={(event) => set('grain', event.target.value)}>
            {(taxonomy.data?.period_grains ?? [...GRAINS]).filter((one) => (GRAINS as readonly string[]).includes(one)).map((one) => (
              <option key={one} value={one}>
                {t(`dis.funding.grain.${camel(one)}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-ordinal" label={t('dis.funding.filter.ordinal')} error={undefined}>
          <select id="fnd-ordinal" value={ordinals(grain).includes(ordinal) ? ordinal : defaultOrdinal} onChange={(event) => set('ordinal', event.target.value)} disabled={grain === 'YEAR'}>
            {ordinals(grain).map((one) => (
              <option key={one} value={one}>
                {one === 0 ? String(planYear) : String(one)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-measure" label={t('dis.funding.filter.measure')} error={undefined}>
          <select id="fnd-measure" value={measure} onChange={(event) => set('measure', event.target.value)}>
            {(taxonomy.data?.measures ?? ['DISBURSED']).map((one) => (
              <option key={one} value={one}>
                {t(`dis.funding.measure.${camel(one)}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-view" label={t('dis.funding.filter.view')} error={undefined}>
          <select id="fnd-view" value={view} onChange={(event) => set('view', event.target.value)}>
            {VIEWS.map((one) => (
              <option key={one} value={one}>
                {t(`dis.funding.view.${camel(one)}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-asof" label={t('dis.funding.filter.asOf')} error={undefined}>
          <input id="fnd-asof" type="date" value={asOf} onChange={(event) => set('asOf', event.target.value)} />
        </Field>
      </FilterPanel>
      <ContextBar
        items={[
          { label: t('dis.funding.ctx.pack'), value: data === undefined ? NONE : t('dis.funding.ctx.packValue', { pack: taxonomy.data?.pack_label ?? data.pack_code, version }) },
          { label: t('dis.funding.ctx.period'), value: data === undefined ? NONE : `${data.period.start} – ${data.period.end}` },
          { label: t('dis.funding.ctx.view'), value: t(`dis.funding.view.${camel(view)}`) },
        ]}
        asOf={data?.as_of}
      />
      {unverified ? <Banner tone="warning" testId="unverified">{t('dis.funding.unverified.notice')}</Banner> : null}
      {frozen ? <Banner tone="info" testId="read-only">{t('dis.funding.readOnly.frozen.notice')}</Banner> : null}
      <StateBoundary state={state} onRetry={() => void board.refetch()}>
        {data === undefined ? null : (
          <>
            <SectionCard title={t('dis.funding.rates.title')}>
              <KpiStrip>
                {ratesOverall(data.totals.rates).map((rate) => (
                  <RateTile key={rate.code} rate={rate} version={version} unverified={unverified} />
                ))}
              </KpiStrip>
              {sharesOf(data.totals.rates).length === 0 ? null : (
                <KpiStrip label={t('dis.funding.shares.title')}>
                  {sharesOf(data.totals.rates).map((rate) => (
                    <RateTile key={`${rate.code}-${rate.class_code}`} rate={rate} version={version} unverified={unverified} />
                  ))}
                </KpiStrip>
              )}
              <ul className="dis-funding-totals" data-testid="totals">
                {['PLAN_IN_FORCE', 'CUMULATIVE_YTD', 'REMAINING_YEAR', 'CONVERSION_DELTA'].map((code) => (
                  <li key={code}>
                    <span>{t(`dis.funding.figure.${camel(code)}`)}</span> <strong>{money(moneyOf(data.totals.money, code))}</strong> {headerInfo(code, t('dis.funding.source.derived'))}
                  </li>
                ))}
              </ul>
            </SectionCard>
            <SectionCard title={t('dis.funding.table.title')} unit={t('dis.funding.table.unit')}>
              <div className="dis-funding-headers" data-testid="header-info">
                {BOARD_COLUMNS.map((column) => (
                  <span key={column.code}>
                    {t(`dis.funding.figure.${camel(column.code)}`)} {headerInfo(column.code, sourceOf(t, column.code))}
                  </span>
                ))}
              </div>
              <DataTable<Row> caption={t('dis.funding.table.caption')} columns={columns} rows={rows} rowKey={(row) => row.key} totals={totalsOf(data, t('dis.funding.total.label'))} totalsLabel={t('dis.funding.total.label')} />
              {data.truncated ? <Banner tone="info" testId="truncated">{t('dis.funding.truncated.notice')}</Banner> : null}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.funding.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const classLabel = (classes: Array<{ code: string; label: string }> | undefined, code: string): string => classes?.find((one) => one.code === code)?.label ?? code;
const ordinals = ordinalsOf;

/** A row of the table is shown when the cell has any figure at all (a class nobody has a figure of is not a row of dashes). */
const hasFigures = (cell: Cell): boolean => BOARD_COLUMNS.some((column) => cell[column.key] !== null);

function totalsOf(data: { totals: { money: Money[] } }, label: string): Record<string, string> {
  const figures = data.totals.money;
  const byCode = (code: string): string => money(moneyOf(figures, code));
  return { project: label, plan_year_vnd: byCode('PLAN_YEAR'), plan_adjusted_vnd: byCode('PLAN_ADJUSTED'), plan_in_force_vnd: byCode('PLAN_IN_FORCE'), plan_period_vnd: byCode('PLAN_PERIOD'), estimate_vnd: byCode('ESTIMATE'), actual_vnd: byCode('ACTUAL'), cumulative_ytd_vnd: byCode('CUMULATIVE_YTD'), cumulative_since_start_vnd: byCode('CUMULATIVE_SINCE_START') };
}

function sourceOf(t: (key: string) => string, code: string): string {
  switch (code) {
    case 'PLAN_YEAR':
    case 'PLAN_ADJUSTED':
    case 'PLAN_IN_FORCE':
      return t('dis.funding.source.plan');
    case 'PLAN_PERIOD':
      return t('dis.funding.source.phasing');
    case 'ESTIMATE':
      return t('dis.funding.source.estimate');
    case 'ACTUAL':
      return t('dis.funding.source.actual');
    default:
      return t('dis.funding.source.derived');
  }
}

function Figure({ value, flash, gaps }: { value: string | null; flash: boolean; gaps: number[] }) {
  const { t } = useTranslation();
  return (
    <span>
      {money(value)}
      {flash ? <small className="dis-funding-flag"> {t('dis.funding.flash')}</small> : null}
      {gaps.length > 0 ? <small className="dis-funding-flag"> {t('dis.funding.gap', { months: gaps.join(', ') })}</small> : null}
    </span>
  );
}
