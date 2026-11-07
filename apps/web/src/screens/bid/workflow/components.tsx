import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { FilterPanel, InfoFormula, StatusPill } from '../../../ui';
import type { DataTableColumn, InfoFormulaLabels, Tone } from '../../../ui';
import { useFilterOptions } from './hooks';
import { countdownText, methodLabel } from './labels';
import { METHODS, appliedCount, billions } from './model';
import type { Filters, WfRow } from './model';
import './workflow.css';

type T = Translator['t'];

export const PATHS = { tree: '/bid/bid-27', board: '/bid/bid-28', package: '/bid/bid-29', analysis: '/bid/bid-30', definitions: '/bid/bid-31' } as const;

/** The three ways to look at the same packages (spec section 2): the tree, the columns by step, the list. The filters travel with the switch. */
export function ViewSwitcher({ active }: { active: 'tree' | 'board' | 'list' }) {
  const { t } = useTranslation();
  const location = useLocation();
  const keep = new URLSearchParams(location.search);
  keep.delete('node');
  keep.delete('view');
  keep.delete('package');
  const withView = (view?: string): string => {
    const search = new URLSearchParams(keep);
    if (view !== undefined) search.set('view', view);
    const text = search.toString();
    return text === '' ? '' : `?${text}`;
  };
  const tabs: Array<{ id: 'tree' | 'board' | 'list'; to: string; label: string }> = [
    { id: 'tree', to: `${PATHS.tree}${withView()}`, label: t('prc1.views.tree.name') },
    { id: 'board', to: `${PATHS.board}${withView()}`, label: t('prc1.views.board.name') },
    { id: 'list', to: `${PATHS.board}${withView('list')}`, label: t('prc1.views.list.name') },
  ];
  return (
    <div className="prc1-views" role="tablist" aria-label={t('prc1.views.group.label')}>
      {tabs.map((tab) => (
        <Link key={tab.id} role="tab" aria-selected={tab.id === active} className={`prc1-views__tab${tab.id === active ? ' is-active' : ''}`} to={tab.to} tabIndex={tab.id === active ? 0 : -1}>
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

export interface FiltersProps {
  filters: Filters;
  onChange: (next: Filters) => void;
  period?: boolean;
  updatedAt?: string | undefined;
}

/** The filters every view shares: unit, project, method, holder, only the late, the period. */
export function WorkflowFilters({ filters, onChange, period = false, updatedAt }: FiltersProps) {
  const { t } = useTranslation();
  const units = useFilterOptions('units');
  const projects = useFilterOptions('projects');
  const owners = useFilterOptions('owners');
  const set = (key: keyof Filters, value: string): void => {
    const next: Filters = { ...filters };
    if (value === '') delete next[key];
    else (next as Record<string, string>)[key] = value;
    onChange(next);
  };
  const select = (id: string, label: string, key: keyof Filters, options: Array<{ value: string; label: string }>) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={(filters[key] as string | undefined) ?? ''} onChange={(event) => set(key, event.target.value)}>
        <option value="">{t('prc1.filter.all.text')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <FilterPanel applied={appliedCount(filters)} unitLabel={t('prc1.unit.billion.name')} updatedAt={updatedAt}>
      {select('prc1-unit', t('prc1.filter.unit.label'), 'unit_id', (units.data ?? []).map((one) => ({ value: one.id, label: one.name })))}
      {select('prc1-project', t('prc1.filter.project.label'), 'project_id', (projects.data ?? []).map((one) => ({ value: one.id, label: one.name })))}
      {select('prc1-method', t('prc1.filter.method.label'), 'method', METHODS.map((method) => ({ value: method, label: methodLabel(t, method) })))}
      {select('prc1-owner', t('prc1.filter.owner.label'), 'owner_id', (owners.data ?? []).map((one) => ({ value: one.id, label: one.name })))}
      <label className="checkbox prc1-late-only">
        <input type="checkbox" checked={filters.late_only === true} onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.checked) next.late_only = true;
            else delete next.late_only;
            onChange(next);
          }} /> {t('prc1.filter.late.label')}
      </label>
      {period && (
        <>
          <div className="field">
            <label htmlFor="prc1-from">{t('prc1.filter.from.label')}</label>
            <input id="prc1-from" type="date" value={filters.from ?? ''} onChange={(event) => set('from', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="prc1-to">{t('prc1.filter.to.label')}</label>
            <input id="prc1-to" type="date" value={filters.to ?? ''} onChange={(event) => set('to', event.target.value)} />
          </div>
        </>
      )}
    </FilterPanel>
  );
}

export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('prc1.info.open.label', { name }),
    close: t('prc1.info.close.label'),
    formula: t('prc1.info.formula.label'),
    numerator: t('prc1.info.numerator.label'),
    denominator: t('prc1.info.denominator.label'),
    exclusions: t('prc1.info.exclusions.label'),
    source: t('prc1.info.source.label'),
    asOf: t('prc1.info.asOf.label'),
    owner: t('prc1.info.owner.label'),
    version: t('prc1.info.version.label'),
    unverified: t('prc1.info.unverified.text'),
  };
}

export type FigureKind = 'total' | 'running' | 'late' | 'stalled' | 'value' | 'median' | 'onTime';

function figureWords(t: T, kind: FigureKind): { name: string; formula: string; numerator?: string; denominator?: string } {
  switch (kind) {
    case 'total':
      return { name: t('prc1.figure.total.name'), formula: t('prc1.figure.total.formula') };
    case 'running':
      return { name: t('prc1.figure.running.name'), formula: t('prc1.figure.running.formula') };
    case 'late':
      return { name: t('prc1.figure.late.name'), formula: t('prc1.figure.late.formula') };
    case 'stalled':
      return { name: t('prc1.figure.stalled.name'), formula: t('prc1.figure.stalled.formula') };
    case 'value':
      return { name: t('prc1.figure.value.name'), formula: t('prc1.figure.value.formula') };
    case 'median':
      return { name: t('prc1.figure.median.name'), formula: t('prc1.figure.median.formula') };
    case 'onTime':
      return { name: t('prc1.figure.onTime.name'), formula: t('prc1.figure.onTime.formula'), numerator: t('prc1.figure.onTime.numerator'), denominator: t('prc1.figure.onTime.denominator') };
  }
}

/** The "i" of a figure of PRC-1: formula, source, the day it is as of, the owner and the version of the definition (G0-4). Days and the standard durations are configuration whose default is not confirmed. */
export function Figure({ kind, asOf }: { kind: FigureKind; asOf: string }) {
  const { t } = useTranslation();
  const words = figureWords(t, kind);
  return (
    <InfoFormula
      name={words.name}
      formula={words.formula}
      numerator={words.numerator}
      denominator={words.denominator}
      source={t('prc1.figure.source.text')}
      asOf={asOf}
      owner={t('prc1.figure.owner.text')}
      version={t('prc1.figure.version.text')}
      unverified={kind === 'late' || kind === 'stalled' || kind === 'median' || kind === 'onTime'}
      labels={infoLabels(t, words.name)}
    />
  );
}

export function Sparkline({ points }: { points: Array<{ step_code: string; days: number }> }) {
  const { t } = useTranslation();
  if (points.length === 0) return null;
  const max = Math.max(1, ...points.map((point) => point.days));
  return (
    <span className="prc1-spark" role="img" aria-label={t('prc1.spark.label', { days: points.map((point) => point.days).join(', ') })}>
      {points.map((point, index) => (
        <span key={`${point.step_code}:${index}`} className="prc1-spark__bar" aria-hidden="true" style={{ height: `${Math.max(12, Math.round((point.days / max) * 100))}%` }} />
      ))}
    </span>
  );
}

const STATUS_TONE: Readonly<Record<WfRow['status'], Tone>> = { NOT_STARTED: 'neutral', IN_PROGRESS: 'info', ON_HOLD: 'neutral', COMPLETED: 'success', CANCELLED: 'neutral' };
export const statusTone = (status: WfRow['status']): Tone => STATUS_TONE[status];

/** The columns of a list of packages (the node panel and the list view): code and name with the method, project, value, days in the step with the little timeline, holder, due with the countdown. */
export function packageColumns(t: T, locale: string, href: (row: WfRow) => string): Array<DataTableColumn<WfRow>> {
  return [
    {
      key: 'package',
      header: t('prc1.column.package.label'),
      pinned: true,
      render: (row) => (
        <span className="prc1-package">
          <Link to={href(row)} className="prc1-package__code">
            {row.package_code}
          </Link>
          <span className="prc1-package__title">{row.title ?? ''}</span>
          <StatusPill tone="neutral">{methodLabel(t, row.method)}</StatusPill>
        </span>
      ),
    },
    { key: 'project', header: t('prc1.column.project.label'), render: (row) => row.project.code },
    { key: 'value', header: t('prc1.column.value.label'), align: 'right', render: (row) => billions(row.value_vnd, locale) },
    {
      key: 'days',
      header: t('prc1.column.days.label'),
      align: 'right',
      render: (row) =>
        row.days_in_step === null ? (
          t('prc1.column.none.text')
        ) : (
          <span className="prc1-days">
            <span>{row.days_in_step.working_days ?? row.days_in_step.calendar_days}</span>
            <Sparkline points={row.sparkline} />
          </span>
        ),
    },
    { key: 'owner', header: t('prc1.column.owner.label'), render: (row) => (row.owner === null ? (row.workflow_id === null ? t('prc1.column.none.text') : t('prc1.column.noOwner.text')) : (row.owner.name ?? t('prc1.column.none.text'))) },
    {
      key: 'due',
      header: t('prc1.column.due.label'),
      render: (row) => (
        <span className={row.late ? 'prc1-due is-late' : 'prc1-due'}>
          {row.status === 'ON_HOLD' ? t('prc1.status.onHold.name') : row.status === 'IN_PROGRESS' ? countdownText(t, row.countdown, row) : t('prc1.column.none.text')}
        </span>
      ),
    },
  ];
}
