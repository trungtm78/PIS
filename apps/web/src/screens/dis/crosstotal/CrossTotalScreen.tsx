import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, InfoFormula, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, InfoFormulaLabels } from '../../../ui';
import { ScopeBar } from '../../ctr/kit';
import { differenceText, vndText } from '../../pay/recon/model';
import { useControl, useEvaluate, useSnapshotHeads } from './hooks';
import { DIMENSIONS, EVALUATE_PERMISSION, READ_PERMISSION, SNAPSHOT_PATH, describeControl, dimensionOf } from './model';
import type { Check, Dimension, KeyAmount, ProjectGap, SnapshotHead } from './model';
import '../dis.css';

type T = ReturnType<typeof useTranslation>['t'];

function dimensionLabel(t: T, dimension: Dimension): string {
  switch (dimension) {
    case 'UNIT':
      return t('govd.cross.dimension.unit');
    case 'FUND':
      return t('govd.cross.dimension.fund');
    case 'PROJECT':
      return t('govd.cross.dimension.project');
  }
}

function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('govd.cross.info.open', { name }),
    close: t('govd.cross.info.close'),
    formula: t('govd.cross.info.formula'),
    numerator: t('govd.cross.info.numerator'),
    denominator: t('govd.cross.info.denominator'),
    exclusions: t('govd.cross.info.exclusions'),
    source: t('govd.cross.info.source'),
    asOf: t('govd.cross.info.asOf'),
    owner: t('govd.cross.info.owner'),
    version: t('govd.cross.info.version'),
    unverified: t('govd.cross.info.unverified'),
  };
}

const snapshotLabel = (t: T, head: SnapshotHead): string => t('govd.cross.snapshot.option', { kind: head.kind, cutoff: head.cutoffDate, status: head.status });

/**
 * DIS-26: the cross-total control of the disbursed money (G4-5). The same Treasury figure of a period snapshot is added up by unit (the lines of the snapshot), by fund and by project (the ledger of the Treasury); the three must be
 * one number to the dong, or the indicator is not published and the freeze of the snapshot is refused. The screen says which dimension disagrees and by how much, which projects differ between the snapshot and the ledger, and how
 * much money has no fund, and it keeps each check it writes as the history of why the snapshot was or was not frozen.
 */
export default function CrossTotalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CrossTotalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CrossTotalContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_PERMISSION);
  const mayEvaluate = holds(EVALUATE_PERMISSION) && mode !== 'READ_ONLY';
  const heads = useSnapshotHeads(mayRead);
  const asked = params.get('snapshot') ?? undefined;
  const chosen = asked ?? heads.data?.[0]?.id;
  const control = useControl(chosen, mayRead);
  const evaluate = useEvaluate();
  const state = useScreenState({ isLoading: heads.isLoading || (chosen !== undefined && control.isLoading), error: heads.error ?? control.error, data: heads.data === undefined ? undefined : control.data ?? heads.data, isEmpty: () => control.data === null });
  const check: Check | undefined = control.data?.live;
  const money = (value: string): string => vndText(value, locale);

  const keyColumns = (dimension: Dimension): DataTableColumn<KeyAmount>[] => [
    { key: 'key', header: t('govd.cross.keys.column.key', { dimension: dimensionLabel(t, dimension) }), pinned: true, render: (entry) => <span data-testid="key-name">{entry.label ?? entry.key}</span> },
    { key: 'vnd', header: t('govd.cross.keys.column.vnd'), align: 'right', render: (entry) => <span data-testid="key-vnd">{money(entry.vnd)}</span> },
  ];
  const gapColumns: DataTableColumn<ProjectGap>[] = [
    { key: 'project', header: t('govd.cross.gaps.column.project'), pinned: true, render: (gap) => <span data-testid="gap-project">{gap.projectCode ?? gap.projectId}</span> },
    { key: 'snapshot', header: t('govd.cross.gaps.column.snapshot'), align: 'right', render: (gap) => <span data-testid="gap-snapshot">{money(gap.snapshotVnd)}</span> },
    { key: 'ledger', header: t('govd.cross.gaps.column.ledger'), align: 'right', render: (gap) => <span data-testid="gap-ledger">{money(gap.ledgerVnd)}</span> },
    { key: 'gap', header: t('govd.cross.gaps.column.gap'), align: 'right', render: (gap) => <span data-testid="gap-gap">{differenceText(gap.gapVnd, locale)}</span> },
  ];
  const historyColumns: DataTableColumn<Check>[] = [
    { key: 'at', header: t('govd.cross.history.column.at'), pinned: true, render: (entry) => <span data-testid="history-at">{entry.createdAt ?? ''}</span> },
    { key: 'origin', header: t('govd.cross.history.column.origin'), render: (entry) => <span data-testid="history-origin">{entry.origin === 'FREEZE_GATE' ? t('govd.cross.history.origin.freeze') : t('govd.cross.history.origin.manual')}</span> },
    {
      key: 'result',
      header: t('govd.cross.history.column.result'),
      render: (entry) => (
        <span data-testid="history-result" data-published={entry.published ? 'yes' : 'no'}>
          <StatusPill tone={entry.published ? 'success' : 'danger'}>{entry.published ? t('govd.cross.history.published') : t('govd.cross.history.notPublished')}</StatusPill>
        </span>
      ),
    },
    { key: 'which', header: t('govd.cross.history.column.which'), render: (entry) => <span data-testid="history-which">{entry.disagreeing.map((dimension) => dimensionLabel(t, dimension)).join(', ')}</span> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govd.cross.title')}</h1>
          <p>{t('govd.cross.subtitle')}</p>
        </div>
      </div>
      <ScopeBar money extra={[{ label: t('govd.cross.ctx.cutoff'), value: control.data?.snapshot.cutoffDate ?? t('govd.cross.ctx.none') }]} updatedAt={control.dataUpdatedAt} stale={control.isRefetchError} />
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('govd.cross.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void (heads.isError ? heads.refetch() : control.refetch())}>
          {heads.data === undefined || heads.data.length === 0 ? (
            <p className="sub" data-testid="no-snapshot">
              {t('govd.cross.snapshot.none')}
            </p>
          ) : (
            <div className="field">
              <label htmlFor="cross-snapshot">{t('govd.cross.snapshot.label')}</label>
              <select id="cross-snapshot" value={chosen ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { snapshot: event.target.value })}>
                {heads.data.map((head) => (
                  <option key={head.id} value={head.id}>
                    {snapshotLabel(t, head)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {check === undefined ? null : (
            <>
              <div className={check.published ? 'callout' : 'callout warning'} role={check.published ? 'status' : 'alert'} data-testid="verdict" data-published={check.published ? 'yes' : 'no'}>
                {check.published ? (
                  <p>{t('govd.cross.verdict.published')}</p>
                ) : (
                  <>
                    <p>{t('govd.cross.verdict.notPublished')}</p>
                    <p data-testid="verdict-which">
                      {check.disagreeing.length === DIMENSIONS.length
                        ? t('govd.cross.verdict.allDisagree')
                        : t('govd.cross.verdict.which', { dimensions: check.disagreeing.map((dimension) => dimensionLabel(t, dimension)).join(', ') })}
                    </p>
                  </>
                )}
              </div>
              <KpiStrip label={t('govd.cross.kpi.label')}>
                {DIMENSIONS.map((dimension) => {
                  const view = dimensionOf(check, dimension);
                  return (
                    <KpiTile
                      key={dimension}
                      label={t('govd.cross.kpi.total', { dimension: dimensionLabel(t, dimension) })}
                      value={money(view.totalVnd)}
                      unit={t('w2pay.ctx.unit')}
                      tone={view.disagrees ? 'danger' : 'success'}
                      sub={view.disagrees ? (view.offsetVnd === null ? t('govd.cross.kpi.disagrees') : t('govd.cross.kpi.offset', { offset: differenceText(view.offsetVnd, locale) })) : t('govd.cross.kpi.agrees')}
                    />
                  );
                })}
              </KpiStrip>
              {BigInt(check.unattributedFundVnd) === 0n ? null : (
                <p className="callout warning" role="status" data-testid="unattributed">
                  {t('govd.cross.unattributed', { amount: money(check.unattributedFundVnd) })}
                </p>
              )}
              <InfoFormula
                name={t('govd.cross.info.name')}
                formula={control.data?.formula === '' || control.data === null || control.data === undefined ? t('govd.cross.info.formulaText') : control.data.formula}
                numerator={t('govd.cross.info.numeratorText', { from: check.windowFrom, to: check.treasuryCutoffDate })}
                denominator={null}
                exclusions={[t('govd.cross.info.exclusionUnattributed')]}
                source={t('govd.cross.info.sourceText')}
                asOf={control.data?.asOf.slice(0, 10) ?? check.treasuryCutoffDate}
                owner={t('govd.cross.info.ownerText')}
                version={t('govd.cross.info.versionText')}
                unverified
                labels={infoLabels(t, t('govd.cross.info.name'))}
              />
              {check.projectGaps.length === 0 ? null : (
                <SectionCard title={t('govd.cross.gaps.title')} unit={t('w2pay.ctx.unit')}>
                  <div data-testid="gaps">
                    <DataTable caption={t('govd.cross.gaps.title')} columns={gapColumns} rows={check.projectGaps} rowKey={(gap) => gap.projectId} />
                  </div>
                </SectionCard>
              )}
              <SectionCard title={t('govd.cross.keys.title')} unit={t('w2pay.ctx.unit')}>
                {DIMENSIONS.map((dimension) => {
                  const view = dimensionOf(check, dimension);
                  return (
                    <div key={dimension} data-testid={`keys-${dimension.toLowerCase()}`}>
                      <h3>{t('govd.cross.keys.heading', { dimension: dimensionLabel(t, dimension), count: view.keyCount })}</h3>
                      {view.top.length === 0 ? (
                        <p className="sub">{t('govd.cross.keys.empty')}</p>
                      ) : (
                        <DataTable caption={t('govd.cross.keys.heading', { dimension: dimensionLabel(t, dimension), count: view.keyCount })} columns={keyColumns(dimension)} rows={view.top} rowKey={(entry) => entry.key} />
                      )}
                    </div>
                  );
                })}
              </SectionCard>
              <SectionCard
                title={t('govd.cross.history.title')}
                actions={
                  mayEvaluate && chosen !== undefined ? (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="evaluate" disabled={evaluate.isPending} onClick={() => evaluate.mutate({ snapshotId: chosen })}>
                      {evaluate.isPending ? t('govd.cross.evaluate.pending') : t('govd.cross.evaluate.action')}
                    </button>
                  ) : null
                }
              >
                {evaluate.isError ? (
                  <p className="callout warning" role="alert" data-testid="evaluate-refusal">
                    {describeControl(evaluate.error) === 'denied' ? t('govd.cross.error.denied') : t('govd.cross.error.general')}
                  </p>
                ) : null}
                {evaluate.isSuccess && evaluate.data !== undefined ? (
                  <p className="callout" role="status" data-testid="evaluate-done">
                    {evaluate.data.published ? t('govd.cross.evaluate.done.published') : t('govd.cross.evaluate.done.notPublished')}
                  </p>
                ) : null}
                {control.data === null || control.data === undefined || control.data.history.length === 0 ? (
                  <p className="sub" data-testid="no-history">
                    {t('govd.cross.history.empty')}
                  </p>
                ) : (
                  <div data-testid="history">
                    <DataTable caption={t('govd.cross.history.title')} columns={historyColumns} rows={control.data.history} rowKey={(entry) => entry.id ?? entry.createdAt ?? ''} />
                  </div>
                )}
                <p className="sub">
                  <Link to={SNAPSHOT_PATH} data-testid="to-snapshot">
                    {t('govd.cross.link.snapshot')}
                  </Link>
                </p>
              </SectionCard>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('govd.cross.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

