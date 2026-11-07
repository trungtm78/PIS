import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, FilterPanel, SectionCard, StatusPill, StickyActions } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import { periodsOf, yearsOf } from '../model';
import type { PeriodView } from '../model';
import { formatVnd } from '../report/money';
import { dueMoment } from '../report/weekly-model';
import '../dis.css';
import '../rates/rates.css';
import { useBuildSnapshot, useFreezeSnapshot, useSnapshotLines, useSnapshots } from './hooks';
import { SNAPSHOT_KINDS, canBuild, canFreeze, describeSnapshot, isFreezable, shortHash } from './model';
import type { LinesPage, SnapshotKind, SnapshotLineView, SnapshotProblem, SnapshotView } from './model';

type T = Translator['t'];

const NONE = '—';
/** Where DIS-22 reopens a locked period: the screen the freeze of a period leads to when the figures need a correction. */
const REOPEN_PATH = '/dis/dis-22';

function problemMessage(t: T, problem: SnapshotProblem): string {
  switch (problem) {
    case 'crossTotal':
      return t('govd.cross.snapshot.problem');
    case 'frozen':
      return t('dis.snapshot.problem.frozen');
    case 'notBuilt':
      return t('dis.snapshot.problem.notBuilt');
    case 'inProgress':
      return t('dis.snapshot.problem.inProgress');
    case 'periodOpen':
      return t('dis.snapshot.problem.periodOpen');
    case 'versionConflict':
      return t('dis.snapshot.problem.versionConflict');
    case 'scopeDenied':
      return t('dis.snapshot.problem.scopeDenied');
    case 'validation':
      return t('dis.snapshot.problem.validation');
    case 'notFound':
      return t('dis.snapshot.problem.notFound');
    case 'general':
      return t('dis.snapshot.problem.general');
  }
}

const kindLabel = (t: T, kind: SnapshotKind): string => (kind === 'PERIOD_CLOSE' ? t('dis.snapshot.kind.periodClose') : kind === 'ADHOC' ? t('dis.snapshot.kind.adhoc') : t('dis.snapshot.kind.mne'));

function statusLabel(t: T, status: SnapshotView['status']): string {
  switch (status) {
    case 'BUILDING':
      return t('dis.snapshot.status.building');
    case 'FROZEN':
      return t('dis.snapshot.status.frozen');
    case 'SUPERSEDED':
      return t('dis.snapshot.status.superseded');
    case 'FAILED':
      return t('dis.snapshot.status.failed');
  }
}

const statusTone = (status: SnapshotView['status']): Tone => (status === 'FROZEN' ? 'success' : status === 'BUILDING' ? 'warning' : status === 'FAILED' ? 'danger' : 'neutral');

function bucketLabel(t: T, bucket: string): string {
  return bucket === 'CURRENT_YEAR' ? t('dis.snapshot.bucket.currentYear') : bucket === 'CARRYOVER' ? t('dis.snapshot.bucket.carryover') : t('dis.snapshot.bucket.other');
}

const levelLabel = (t: T, level: string): string => (level === 'CENTRAL' ? t('dis.snapshot.level.central') : t('dis.snapshot.level.local'));

function coverageLabel(t: T, coverage: string): string {
  return coverage === 'COMPLETE' ? t('dis.snapshot.coverage.complete') : coverage === 'PARTIAL' ? t('dis.snapshot.coverage.partial') : t('dis.snapshot.coverage.none');
}

function nullReasonLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'ZERO_DENOMINATOR':
      return t('dis.snapshot.reason.zeroDenominator');
    case 'TREASURY_COVERAGE_NONE':
      return t('dis.snapshot.reason.noTreasury');
    case 'NO_DATA':
      return t('dis.snapshot.reason.noData');
    default:
      return NONE;
  }
}

const money = (value: string | null): string => (value === null ? NONE : formatVnd(value));

/** The label that says the formulas are proposals until the business owner signs them (D03). */
function DefinitionPill({ definition }: { definition: SnapshotView['definitionStatus'] }) {
  const { t } = useTranslation();
  return definition === 'SIGNED' ? (
    <span data-testid="definition-signed">
      <StatusPill tone="success">{t('dis.snapshot.definition.signed')}</StatusPill>
    </span>
  ) : (
    <span data-testid="definition-pending" title={t('dis.snapshot.definition.pending.title')}>
      <StatusPill tone="warning">{t('dis.snapshot.definition.pending')}</StatusPill>
    </span>
  );
}

/**
 * DIS-21: the close and freeze of the figures of a period (ST-DIS-009, DIS 3 F6). A snapshot is built from the accepted reports, the plan in force and the Treasury up to a cutoff, looked at, and then frozen:
 * after that it never changes, and a correction is a newer snapshot that takes its place. The formulas are proposals until the business owner signs them (D03), and every snapshot says so.
 */
export default function SnapshotScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <SnapshotContent key={tenantId ?? 'none'} route={route} />;
}

function SnapshotContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const periods = usePeriods();
  const [year, setYear] = useState<number | undefined>(undefined);
  const [periodId, setPeriodId] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: periods.isLoading, error: periods.error, data: periods.data, isEmpty: () => false });
  const all = periods.data ?? [];
  const currentYear = new Date().getFullYear();
  const shownYear = year ?? currentYear;
  const inYear = periodsOf(all, shownYear, '');
  const period = inYear.find((candidate) => candidate.id === periodId);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.snapshot.page.title')}</h1>
          <p>{t('dis.snapshot.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('dis.wr.ctx.period'), value: period?.code ?? t('dis.wr.ctx.period.none') },
          { label: t('dis.wr.ctx.deadline'), value: period === undefined ? t('dis.wr.ctx.period.none') : dueMoment(period.deadlineAt) },
        ]}
      />
      <StateBoundary state={state} onRetry={() => void periods.refetch()}>
        <div className="w2dis-stack">
          <FilterPanel applied={periodId === '' ? 0 : 1}>
            <div className="dis-filters">
              <Field id="snapshot-year" label={t('dis.snapshot.year.label')} error={undefined}>
                <select
                  id="snapshot-year"
                  value={shownYear}
                  onChange={(event) => {
                    setYear(Number(event.target.value));
                    setPeriodId('');
                    setSelected(undefined);
                  }}
                >
                  {yearsOf(all, currentYear).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="snapshot-period" label={t('dis.snapshot.period.label')} error={undefined}>
                <select
                  id="snapshot-period"
                  value={periodId}
                  onChange={(event) => {
                    setPeriodId(event.target.value);
                    setSelected(undefined);
                  }}
                >
                  <option value="">{t('dis.snapshot.period.choose.option')}</option>
                  {inYear.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.code}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </FilterPanel>
          {period === undefined ? (
            <p className="w2dis-empty" data-testid="snapshot-choose">
              {t('dis.snapshot.choose.text')}
            </p>
          ) : (
            <Period key={period.id} period={period} permissions={permissions} mode={mode} selected={selected} onSelect={setSelected} />
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('dis.snapshot.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Period({ period, permissions, mode, selected, onSelect }: { period: PeriodView; permissions: readonly string[] | undefined; mode: 'FULL' | 'READ_ONLY' | undefined; selected: string | undefined; onSelect(id: string | undefined): void }) {
  const { t } = useTranslation();
  const list = useSnapshots(period.id);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const [freezing, setFreezing] = useState<SnapshotView | undefined>(undefined);
  const data = list.data;
  const columns: DataTableColumn<SnapshotView>[] = [
    { key: 'kind', header: t('dis.snapshot.col.kind'), pinned: true, render: (snapshot) => <strong>{kindLabel(t, snapshot.kind)}</strong> },
    { key: 'status', header: t('dis.snapshot.col.status'), render: (snapshot) => <StatusPill tone={statusTone(snapshot.status)}>{statusLabel(t, snapshot.status)}</StatusPill> },
    { key: 'cutoff', header: t('dis.snapshot.col.cutoff'), render: (snapshot) => snapshot.cutoffDate },
    { key: 'definition', header: t('dis.snapshot.col.definition'), render: (snapshot) => <DefinitionPill definition={snapshot.definitionStatus} /> },
    {
      key: 'hash',
      header: t('dis.snapshot.col.hash'),
      render: (snapshot) => (
        <code className="w2dis-code" title={snapshot.payloadSha256 ?? undefined}>
          {shortHash(snapshot.payloadSha256) || NONE}
        </code>
      ),
    },
    { key: 'rows', header: t('dis.snapshot.col.rows'), align: 'right', render: (snapshot) => String(snapshot.rowCount) },
    {
      key: 'actions',
      header: t('dis.snapshot.col.actions'),
      render: (snapshot) => (
        <div className="w2dis-cell-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={selected === snapshot.id} onClick={() => onSelect(snapshot.id)}>
            {t('dis.snapshot.lines.action', { kind: kindLabel(t, snapshot.kind), cutoff: snapshot.cutoffDate })}
          </button>
          {isFreezable(snapshot) && canFreeze(permissions, mode) ? (
            <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => setFreezing(snapshot)}>
              {t('dis.snapshot.freeze.action')}
            </button>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <StateBoundary state={state} onRetry={() => void list.refetch()}>
      {data === undefined ? null : (
        <>
          <BuildForm period={period} allowed={canBuild(permissions, mode)} onBuilt={onSelect} />
          <SectionCard title={t('dis.snapshot.list.title')}>
            {data.items.length === 0 ? (
              <p className="w2dis-empty" data-testid="snapshot-none">
                {t('dis.snapshot.list.empty.text')}
              </p>
            ) : (
              <DataTable caption={t('dis.snapshot.list.aria')} columns={columns} rows={data.items} rowKey={(snapshot) => snapshot.id} />
            )}
            {period.status === 'LOCKED' ? (
              <p className="w2dis-note">
                <Link to={REOPEN_PATH}>{t('dis.snapshot.reopen.link')}</Link>
              </p>
            ) : null}
          </SectionCard>
          <SectionCard title={t('dis.snapshot.pending.title')}>
            <p className="w2dis-note">{t('dis.snapshot.pending.hint')}</p>
            {data.pending.length === 0 ? (
              <p className="w2dis-empty" data-testid="pending-none">
                {t('dis.snapshot.pending.empty.text')}
              </p>
            ) : (
              <ul data-testid="pending">
                {data.pending.map((report) => (
                  <li key={report.reportId}>{t('dis.snapshot.pending.item', { code: report.projectCode, revision: report.revision })}</li>
                ))}
              </ul>
            )}
          </SectionCard>
          {selected === undefined ? null : <Lines key={selected} id={selected} />}
          {freezing === undefined ? null : <FreezeFlow snapshot={freezing} period={period} onClose={() => setFreezing(undefined)} />}
        </>
      )}
    </StateBoundary>
  );
}

function BuildForm({ period, allowed, onBuilt }: { period: PeriodView; allowed: boolean; onBuilt(id: string | undefined): void }) {
  const { t } = useTranslation();
  const build = useBuildSnapshot();
  const [kind, setKind] = useState<SnapshotKind>('PERIOD_CLOSE');
  const [cutoff, setCutoff] = useState(period.endDate);
  const [submitted, setSubmitted] = useState(false);
  const missing = submitted && cutoff === '';
  const refusal = build.isError ? describeSnapshot(build.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!allowed || build.isPending || cutoff === '') return;
    build.mutate(
      { periodId: period.id, kind, cutoffDate: cutoff },
      {
        onSuccess: (done) => {
          const id = (done as { resource_id?: unknown } | undefined)?.resource_id;
          onBuilt(typeof id === 'string' ? id : undefined);
        },
      },
    );
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('dis.snapshot.build.title')} data-testid="snapshot-build">
      <SectionCard title={t('dis.snapshot.build.title')}>
        <div className="w2dis-stack">
          {allowed ? null : (
            <p className="w2dis-banner w2dis-banner--info" role="status" data-testid="build-denied">
              {t('dis.snapshot.build.denied.note')}
            </p>
          )}
          {refusal === undefined ? null : (
            <p className="w2dis-banner" role="alert" data-testid="build-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <div className="w2dis-form-grid">
            <Field id="build-kind" label={t('dis.snapshot.kind.label')} error={undefined}>
              <select id="build-kind" value={kind} onChange={(event) => setKind(event.target.value as SnapshotKind)}>
                {SNAPSHOT_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {kindLabel(t, option)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="build-cutoff" label={t('dis.snapshot.cutoff.label')} hint={t('dis.snapshot.cutoff.hint')} error={missing ? t('dis.snapshot.cutoff.required.error') : undefined}>
              <input id="build-cutoff" type="date" value={cutoff} min={period.startDate} onChange={(event) => setCutoff(event.target.value)} />
            </Field>
          </div>
          <StickyActions
            primary={
              <button type="submit" className="ui-button ui-button--primary" disabled={!allowed || build.isPending}>
                {build.isPending ? t('dis.snapshot.build.pending') : t('dis.snapshot.build.action')}
              </button>
            }
          />
        </div>
      </SectionCard>
    </form>
  );
}

/**
 * The confirmation of a freeze: it names the snapshot, the period and what the freeze does (the figures stop moving and the one frozen before is replaced) and sends it under the version the list showed.
 * A refusal is told in words in the dialog and, as an alert, on the page, so a screen reader hears it while the dialog stays open.
 */
function FreezeFlow({ snapshot, period, onClose }: { snapshot: SnapshotView; period: PeriodView; onClose(): void }) {
  const { t } = useTranslation();
  const freeze = useFreezeSnapshot();
  const refusal = freeze.isError ? describeSnapshot(freeze.error) : undefined;
  const refusalText = refusal === undefined ? undefined : problemMessage(t, refusal);
  const context = [
    { label: t('w2dis.snapshot.freeze.object'), value: t('dis.snapshot.freeze.dialog.title', { kind: kindLabel(t, snapshot.kind), cutoff: snapshot.cutoffDate }) },
    { label: t('dis.wr.ctx.period'), value: period.code },
    { label: t('dis.snapshot.col.status'), value: statusLabel(t, snapshot.status) },
    { label: t('w2dis.snapshot.freeze.effect'), value: t('dis.snapshot.freeze.dialog.body') },
    ...(snapshot.definitionStatus === 'SIGNED' ? [] : [{ label: t('dis.snapshot.col.definition'), value: t('dis.snapshot.freeze.dialog.definition') }]),
    ...(refusalText === undefined ? [] : [{ label: t('w2dis.snapshot.freeze.error'), value: refusalText }]),
  ];
  return (
    <>
      <p className="ui-sr-only" role="status">
        {freeze.isPending ? t('dis.snapshot.freeze.pending') : ''}
      </p>
      {refusalText === undefined ? null : (
        <p className="w2dis-banner" role="alert" data-testid="freeze-refusal">
          {refusalText}
          {refusal === 'crossTotal' ? (
            <>
              {' '}
              <Link to={`/dis/dis-26?snapshot=${snapshot.id}`} data-testid="cross-total-link">
                {t('govd.cross.snapshot.link')}
              </Link>
            </>
          ) : null}
        </p>
      )}
      <ConfirmDialog
        open
        title={t('dis.snapshot.freeze.confirm.action')}
        context={context}
        confirmLabel={t('dis.snapshot.freeze.confirm.action')}
        cancelLabel={t('dis.snapshot.dialog.cancel.action')}
        pending={freeze.isPending}
        onCancel={onClose}
        onConfirm={() => freeze.mutate({ snapshot }, { onSuccess: onClose })}
      />
    </>
  );
}

/** The lines of a snapshot: both rates side by side, never one alone, and a figure nobody has is a dash with its reason, never a zero. */
function Lines({ id }: { id: string }) {
  const { t } = useTranslation();
  const lines = useSnapshotLines(id);
  const state = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data, isEmpty: (data) => (data as { pages: LinesPage[] }).pages.every((page) => page.items.length === 0) });
  const items: SnapshotLineView[] = (lines.data?.pages ?? []).flatMap((page) => page.items);
  const plan = t('w2dis.rates.group.plan');
  const paid = t('w2dis.rates.group.disbursed');
  const rates = t('w2dis.rates.group.rates');
  const rate = (line: SnapshotLineView, value: string | null, kind: 'pm' | 'total') => (
    <span data-rate={kind} title={value === null ? nullReasonLabel(t, line.rateNullReason) : undefined}>
      {value === null ? NONE : t('dis.snapshot.rate.text', { value })}
    </span>
  );
  const columns: DataTableColumn<SnapshotLineView>[] = [
    { key: 'project', header: t('dis.snapshot.line.project'), pinned: true, render: (line) => <strong>{line.projectCode}</strong> },
    { key: 'cell', header: t('dis.snapshot.line.cell'), render: (line) => t('dis.snapshot.line.cell.text', { bucket: bucketLabel(t, line.bucket), level: levelLabel(t, line.budgetLevel) }) },
    { key: 'planPm', header: t('dis.snapshot.line.planPm'), group: plan, align: 'right', render: (line) => money(line.planPmVnd) },
    { key: 'planLocal', header: t('dis.snapshot.line.planLocal'), group: plan, align: 'right', render: (line) => money(line.planLocalVnd) },
    { key: 'treasury', header: t('dis.snapshot.line.treasury'), group: paid, align: 'right', render: (line) => money(line.treasuryVnd) },
    { key: 'reported', header: t('dis.snapshot.line.reported'), group: paid, align: 'right', render: (line) => money(line.reportedVnd) },
    { key: 'delta', header: t('dis.snapshot.line.delta'), group: paid, align: 'right', render: (line) => (line.deltaVnd === null ? NONE : signed(line.deltaVnd)) },
    { key: 'ratePm', header: t('dis.snapshot.line.ratePm'), group: rates, align: 'right', render: (line) => rate(line, line.ratePmPct, 'pm') },
    { key: 'rateTotal', header: t('dis.snapshot.line.rateTotal'), group: rates, align: 'right', render: (line) => rate(line, line.rateTotalPct, 'total') },
    { key: 'coverage', header: t('dis.snapshot.line.coverage'), render: (line) => <StatusPill tone={line.coverage === 'COMPLETE' ? 'success' : line.coverage === 'PARTIAL' ? 'warning' : 'neutral'}>{coverageLabel(t, line.coverage)}</StatusPill> },
  ];
  return (
    <div data-testid="snapshot-lines">
      <SectionCard title={t('dis.snapshot.lines.title')} unit={t('dis.wr.unit')}>
        <StateBoundary state={state} onRetry={() => void lines.refetch()}>
          <DataTable caption={t('dis.snapshot.lines.aria')} columns={columns} rows={items} rowKey={(line) => line.id} />
          {lines.hasNextPage ? (
            <p className="w2dis-more">
              <button type="button" className="ui-button ui-button--outline" disabled={lines.isFetchingNextPage} onClick={() => void lines.fetchNextPage()}>
                {t('dis.snapshot.lines.more.action')}
              </button>
            </p>
          ) : null}
        </StateBoundary>
      </SectionCard>
    </div>
  );
}

/** A change with its sign: a fall is negative and a rise is shown with a plus, so that none of them is read as zero. */
function signed(amount: string): string {
  return amount.startsWith('-') ? formatVnd(amount) : amount === '0' ? '0' : `+${formatVnd(amount)}`;
}
