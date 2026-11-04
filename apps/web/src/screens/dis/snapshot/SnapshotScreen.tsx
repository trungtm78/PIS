import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import { periodsOf, yearsOf } from '../model';
import type { PeriodView } from '../model';
import { formatVnd } from '../report/money';
import '../dis.css';
import { useBuildSnapshot, useFreezeSnapshot, useSnapshotLines, useSnapshots } from './hooks';
import { SNAPSHOT_KINDS, canBuild, canFreeze, describeSnapshot, isFreezable, shortHash } from './model';
import type { LinesPage, SnapshotKind, SnapshotLineView, SnapshotProblem, SnapshotView } from './model';

type T = Translator['t'];

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';
const NONE = '—';
/** Where DIS-22 reopens a locked period: the screen the freeze of a period leads to when the figures need a correction. */
const REOPEN_PATH = '/dis/dis-22';

function problemMessage(t: T, problem: SnapshotProblem): string {
  switch (problem) {
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

const statusTone = (status: SnapshotView['status']): 'green' | 'warn' | 'gray' => (status === 'FROZEN' ? 'green' : status === 'BUILDING' ? 'warn' : 'gray');

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
  const { permissions, mode } = useSession();
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
      <StateBoundary state={state} onRetry={() => void periods.refetch()}>
        <div className="card">
          <div className="formgrid">
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
        </div>
        {period === undefined ? (
          <p className="muted" data-testid="snapshot-choose">
            {t('dis.snapshot.choose.text')}
          </p>
        ) : (
          <Period key={period.id} period={period} permissions={permissions} mode={mode} selected={selected} onSelect={setSelected} />
        )}
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
  return (
    <StateBoundary state={state} onRetry={() => void list.refetch()}>
      {data === undefined ? null : (
        <>
          <BuildForm period={period} allowed={canBuild(permissions, mode)} onBuilt={onSelect} />
          <section className="card" aria-labelledby="snapshot-list-title">
            <h2 id="snapshot-list-title">{t('dis.snapshot.list.title')}</h2>
            {data.items.length === 0 ? (
              <p className="muted" data-testid="snapshot-none">
                {t('dis.snapshot.list.empty.text')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table" aria-label={t('dis.snapshot.list.aria')} data-testid="snapshots">
                  <thead>
                    <tr>
                      <th scope="col">{t('dis.snapshot.col.kind')}</th>
                      <th scope="col">{t('dis.snapshot.col.status')}</th>
                      <th scope="col">{t('dis.snapshot.col.cutoff')}</th>
                      <th scope="col">{t('dis.snapshot.col.definition')}</th>
                      <th scope="col">{t('dis.snapshot.col.hash')}</th>
                      <th scope="col" className="num">
                        {t('dis.snapshot.col.rows')}
                      </th>
                      <th scope="col">
                        <span className="sr-only">{t('dis.snapshot.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((snapshot) => (
                      <tr key={snapshot.id} data-snapshot={snapshot.id} data-status={snapshot.status} aria-selected={selected === snapshot.id}>
                        <td>{kindLabel(t, snapshot.kind)}</td>
                        <td>
                          <span className={`pill ${statusTone(snapshot.status)}`}>{statusLabel(t, snapshot.status)}</span>
                        </td>
                        <td>{snapshot.cutoffDate}</td>
                        <td>
                          {snapshot.definitionStatus === 'SIGNED' ? (
                            <span className="pill green" data-testid="definition-signed">
                              {t('dis.snapshot.definition.signed')}
                            </span>
                          ) : (
                            <span className="pill warn" data-testid="definition-pending" title={t('dis.snapshot.definition.pending.title')}>
                              {t('dis.snapshot.definition.pending')}
                            </span>
                          )}
                        </td>
                        <td title={snapshot.payloadSha256 ?? undefined}>
                          <code>{shortHash(snapshot.payloadSha256) || NONE}</code>
                        </td>
                        <td className="num">{snapshot.rowCount}</td>
                        <td>
                          <button type="button" onClick={() => onSelect(snapshot.id)}>
                            {t('dis.snapshot.lines.action', { kind: kindLabel(t, snapshot.kind), cutoff: snapshot.cutoffDate })}
                          </button>{' '}
                          {isFreezable(snapshot) && canFreeze(permissions, mode) ? (
                            <button type="button" className="primary" onClick={() => setFreezing(snapshot)}>
                              {t('dis.snapshot.freeze.action')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {period.status === 'LOCKED' ? (
              <p className="sub">
                <Link to={REOPEN_PATH}>{t('dis.snapshot.reopen.link')}</Link>
              </p>
            ) : null}
          </section>
          <section className="card" aria-labelledby="snapshot-pending-title">
            <h2 id="snapshot-pending-title">{t('dis.snapshot.pending.title')}</h2>
            <p className="sub">{t('dis.snapshot.pending.hint')}</p>
            {data.pending.length === 0 ? (
              <p className="muted" data-testid="pending-none">
                {t('dis.snapshot.pending.empty.text')}
              </p>
            ) : (
              <ul data-testid="pending">
                {data.pending.map((report) => (
                  <li key={report.reportId}>{t('dis.snapshot.pending.item', { code: report.projectCode, revision: report.revision })}</li>
                ))}
              </ul>
            )}
          </section>
          {selected === undefined ? null : <Lines key={selected} id={selected} />}
          {freezing === undefined ? null : <FreezeDialog snapshot={freezing} onClose={() => setFreezing(undefined)} />}
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
    <form className="card" onSubmit={submit} noValidate aria-labelledby="snapshot-build-title" data-testid="snapshot-build">
      <h2 id="snapshot-build-title">{t('dis.snapshot.build.title')}</h2>
      {allowed ? null : (
        <p className="callout warning" role="status" data-testid="build-denied">
          {t('dis.snapshot.build.denied.note')}
        </p>
      )}
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="build-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      <div className="formgrid">
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
      <div className="formfooter">
        <button type="submit" className="primary" disabled={!allowed || build.isPending}>
          {build.isPending ? t('dis.snapshot.build.pending') : t('dis.snapshot.build.action')}
        </button>
      </div>
    </form>
  );
}

/** The confirmation of a freeze: it says what the freeze does (the figures stop moving and the one frozen before is replaced) and sends it under the version the list showed. */
function FreezeDialog({ snapshot, onClose }: { snapshot: SnapshotView; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const freeze = useFreezeSnapshot();
  const refusal = freeze.isError ? describeSnapshot(freeze.error) : undefined;
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('dis.snapshot.freeze.dialog.title', { kind: kindLabel(t, snapshot.kind), cutoff: snapshot.cutoffDate })}</strong>
          <button type="button" className="icon-button" aria-label={t('dis.snapshot.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="dis-dialog-body">
          <p>{t('dis.snapshot.freeze.dialog.body')}</p>
          {snapshot.definitionStatus === 'SIGNED' ? null : (
            <p className="callout warning" data-testid="freeze-definition-note">
              {t('dis.snapshot.freeze.dialog.definition')}
            </p>
          )}
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="freeze-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('dis.snapshot.dialog.cancel.action')}
            </button>
            <button type="button" className="primary" disabled={freeze.isPending} onClick={() => freeze.mutate({ snapshot }, { onSuccess: onClose })}>
              {freeze.isPending ? t('dis.snapshot.freeze.pending') : t('dis.snapshot.freeze.confirm.action')}
            </button>
          </div>
        </div>
      </section>
    </NavigationDialog>
  );
}

/** The lines of a snapshot: both rates side by side, never one alone, and a figure nobody has is a dash with its reason, never a zero. */
function Lines({ id }: { id: string }) {
  const { t } = useTranslation();
  const lines = useSnapshotLines(id);
  const state = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data, isEmpty: (data) => (data as { pages: LinesPage[] }).pages.every((page) => page.items.length === 0) });
  const items: SnapshotLineView[] = (lines.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <section className="card" aria-labelledby="snapshot-lines-title" data-testid="snapshot-lines">
      <h2 id="snapshot-lines-title">{t('dis.snapshot.lines.title')}</h2>
      <StateBoundary state={state} onRetry={() => void lines.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('dis.snapshot.lines.aria')} data-testid="lines">
            <thead>
              <tr>
                <th scope="col">{t('dis.snapshot.line.project')}</th>
                <th scope="col">{t('dis.snapshot.line.cell')}</th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.planPm')}
                </th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.planLocal')}
                </th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.treasury')}
                </th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.reported')}
                </th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.delta')}
                </th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.ratePm')}
                </th>
                <th scope="col" className="num">
                  {t('dis.snapshot.line.rateTotal')}
                </th>
                <th scope="col">{t('dis.snapshot.line.coverage')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((line) => (
                <tr key={line.id} data-line={line.id}>
                  <td>{line.projectCode}</td>
                  <td>{t('dis.snapshot.line.cell.text', { bucket: bucketLabel(t, line.bucket), level: levelLabel(t, line.budgetLevel) })}</td>
                  <td className="num">{money(line.planPmVnd)}</td>
                  <td className="num">{money(line.planLocalVnd)}</td>
                  <td className="num">{money(line.treasuryVnd)}</td>
                  <td className="num">{money(line.reportedVnd)}</td>
                  <td className="num">{line.deltaVnd === null ? NONE : signed(line.deltaVnd)}</td>
                  <td className="num" data-rate="pm" title={line.ratePmPct === null ? nullReasonLabel(t, line.rateNullReason) : undefined}>
                    {line.ratePmPct === null ? NONE : t('dis.snapshot.rate.text', { value: line.ratePmPct })}
                  </td>
                  <td className="num" data-rate="total" title={line.rateTotalPct === null ? nullReasonLabel(t, line.rateNullReason) : undefined}>
                    {line.rateTotalPct === null ? NONE : t('dis.snapshot.rate.text', { value: line.rateTotalPct })}
                  </td>
                  <td>{coverageLabel(t, line.coverage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lines.hasNextPage ? (
          <p>
            <button type="button" disabled={lines.isFetchingNextPage} onClick={() => void lines.fetchNextPage()}>
              {t('dis.snapshot.lines.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}

/** A change with its sign: a fall is negative and a rise is shown with a plus, so that none of them is read as zero. */
function signed(amount: string): string {
  return amount.startsWith('-') ? formatVnd(amount) : amount === '0' ? '0' : `+${formatVnd(amount)}`;
}
