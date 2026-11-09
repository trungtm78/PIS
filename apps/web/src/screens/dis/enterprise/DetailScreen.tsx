import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import '../dis.css';
import { Banner } from '../funding/components';
import { useFreeze, useSnapshot } from './hooks';
import { RateText, STATUS_TONES, SinceStartTile, SnapshotLink } from './components';
import { BUILD_PATH, FREEZE_PERMISSION, NONE, SUMMARY_COLUMNS, camel, describeProblem, money, moneyOf, rateOf, shortHash } from './model';
import type { IndicatorRow, LineageRow, ProjectRow, SnapshotDetail, UnitRow } from './model';
import './enterprise.css';

/**
 * DIS-33: one enterprise period snapshot (ENT-3a, docs/ent-snapshot.md; R17, R21). Everything is read through the one reader on the server: the totals and the rate of the year with the sum above and the sum below the line, the
 * rate since the start, the figures by class, by unit and by project, the indicator figures that were frozen with it and the lineage of its revisions. A snapshot that is still being built is reviewed here and frozen by a
 * second person (a confirmation first); a frozen one shows its hash and whether the stored rows still give it. A figure nobody has is a dash, never zero.
 */
export default function DetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const snapshotId = params.get('snapshot') ?? undefined;
  const measure = params.get('measure') ?? undefined;
  const detail = useSnapshot(snapshotId, measure);
  const freeze = useFreeze();
  const [confirming, setConfirming] = useState(false);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: detail.data });
  const data: SnapshotDetail | undefined = detail.data;
  const frozenMode = mode === 'READ_ONLY';
  const canFreeze = data !== undefined && data.actions.freeze && (permissions === undefined || permissions.includes(FREEZE_PERMISSION)) && !frozenMode;
  const problem = freeze.error === null ? undefined : describeProblem(freeze.error);
  const asOf = data?.as_of ?? '';
  const version = data?.pack.version ?? 0;

  const confirm = (): void => {
    if (data === undefined) return;
    freeze.mutate({ snapshotId: data.snapshot.id, version: data.snapshot.version }, { onSuccess: () => setConfirming(false) });
  };
  const cancel = (): void => {
    setConfirming(false);
    freeze.reset();
  };

  const unitColumns: DataTableColumn<UnitRow>[] = [
    { key: 'unit', header: t('ent3a.detail.col.unit'), pinned: true, render: (row) => `${row.unit_code} · ${row.unit_name}` },
    { key: 'projects', header: t('ent3a.detail.col.projects'), align: 'right', render: (row) => String(row.projects) },
    ...SUMMARY_COLUMNS.map((code) => ({ key: code, header: t(`ent3a.detail.money.${camel(code)}`), align: 'right' as const, render: (row: UnitRow) => money(moneyOf(row.money, code)) })),
    { key: 'rate', header: t('ent3a.detail.col.rate'), align: 'right', render: (row) => <RateText rate={rateOf(row.rates, 'RATE_YEAR_IN_FORCE')} /> },
  ];
  const projectColumns: DataTableColumn<ProjectRow>[] = [
    { key: 'project', header: t('ent3a.detail.col.project'), pinned: true, render: (row) => `${row.project_code} · ${row.project_name}` },
    { key: 'unit', header: t('ent3a.detail.col.unit'), render: (row) => row.unit_code },
    { key: 'tmdt', header: t('ent3a.detail.col.tmdt'), align: 'right', render: (row) => money(row.tmdt_in_force_vnd) },
    ...SUMMARY_COLUMNS.map((code) => ({ key: code, header: t(`ent3a.detail.money.${camel(code)}`), align: 'right' as const, render: (row: ProjectRow) => money(moneyOf(row.money, code)) })),
    { key: 'rate', header: t('ent3a.detail.col.rate'), align: 'right', render: (row) => <RateText rate={rateOf(row.rates, 'RATE_YEAR_IN_FORCE')} /> },
  ];
  const indicatorColumns: DataTableColumn<IndicatorRow>[] = [
    { key: 'project', header: t('ent3a.detail.col.project'), pinned: true, render: (row) => row.project_code },
    { key: 'unit', header: t('ent3a.detail.col.unit'), render: (row) => row.unit_code },
    { key: 'indicator', header: t('ent3a.detail.col.indicator'), render: (row) => row.indicator_code },
    { key: 'value', header: t('ent3a.detail.col.value'), align: 'right', render: (row) => `${row.value} ${row.unit}` },
    { key: 'revision', header: t('ent3a.detail.col.revision'), align: 'right', render: (row) => String(row.revision) },
  ];
  const lineageColumns: DataTableColumn<LineageRow>[] = [
    { key: 'revision', header: t('ent3a.detail.col.revision'), align: 'right', pinned: true, render: (row) => String(row.revision) },
    { key: 'status', header: t('ent3a.detail.col.status'), render: (row) => <StatusPill tone={STATUS_TONES[row.status]}>{t(`ent3a.status.${camel(row.status)}`)}</StatusPill> },
    { key: 'hash', header: t('ent3a.detail.col.hash'), render: (row) => <span className="dis-ent-hash">{shortHash(row.payload_sha256)}</span> },
    { key: 'frozenAt', header: t('ent3a.detail.col.frozenAt'), render: (row) => row.frozen_at ?? NONE },
    { key: 'open', header: t('ent3a.detail.col.open'), render: (row) => <SnapshotLink id={row.id}>{t('ent3a.build.row.open')}</SnapshotLink> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ent3a.detail.title')}</h1>
          <p>{t('ent3a.detail.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={BUILD_PATH}>
          {t('ent3a.detail.toBuild')}
        </Link>
      </div>
      {snapshotId === undefined ? (
        <p className="sub" data-testid="no-snapshot">
          {t('ent3a.detail.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void detail.refetch()}>
          {data === undefined ? null : (
            <>
              <ContextBar
                items={[
                  { label: t('ent3a.detail.ctx.period'), value: data.snapshot.period_code },
                  { label: t('ent3a.detail.ctx.revision'), value: String(data.snapshot.revision) },
                  { label: t('ent3a.detail.ctx.status'), value: t(`ent3a.status.${camel(data.snapshot.status)}`) },
                  { label: t('ent3a.detail.ctx.asOf'), value: asOf },
                ]}
              />
              {data.partial ? <Banner tone="info" testId="partial">{t('ent3a.detail.partial')}</Banner> : null}
              {data.snapshot.definition_status === 'PROPOSED_PENDING_SIGNOFF' ? <Banner tone="warning" testId="unverified">{t('ent3a.unverified.notice')}</Banner> : null}
              {data.snapshot.status === 'BUILDING' ? <Banner tone="info" testId="building">{t('ent3a.detail.building')}</Banner> : null}
              {data.snapshot.status === 'SUPERSEDED' ? <Banner tone="info" testId="superseded">{t('ent3a.detail.superseded')}</Banner> : null}
              <SectionCard title={t('ent3a.detail.hash.title')}>
                <dl className="dis-ent-facts">
                  <div>
                    <dt>{t('ent3a.detail.hash.value')}</dt>
                    <dd className="dis-ent-hash" data-testid="hash">
                      {data.snapshot.payload_sha256 ?? NONE}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('ent3a.detail.hash.check')}</dt>
                    <dd data-testid="hash-check">{data.hash_verified === null ? NONE : data.hash_verified ? t('ent3a.detail.hash.ok') : t('ent3a.detail.hash.broken')}</dd>
                  </div>
                  <div>
                    <dt>{t('ent3a.detail.hash.rows')}</dt>
                    <dd>{t('ent3a.detail.hash.rowsValue', { figures: data.snapshot.figure_count ?? 0, indicators: data.snapshot.indicator_count ?? 0 })}</dd>
                  </div>
                </dl>
                {canFreeze ? (
                  <div className="dis-ent-actions">
                    <button type="button" className="ui-button" disabled={freeze.isPending} onClick={() => setConfirming(true)}>
                      {t('ent3a.detail.action.freeze')}
                    </button>
                  </div>
                ) : data.snapshot.status === 'BUILDING' ? (
                  <small className="sub" data-testid="cannot-freeze">
                    {t('ent3a.detail.action.cannotFreeze')}
                  </small>
                ) : null}
                {problem === undefined || confirming ? null : (
                  <Banner tone="warning" testId="problem">
                    {t(`ent3a.detail.problem.${problem}`)}
                  </Banner>
                )}
              </SectionCard>
              <SectionCard title={t('ent3a.detail.totals.title')}>
                <dl className="dis-ent-facts">
                  <div>
                    <dt>{t('ent3a.detail.totals.planInForce')}</dt>
                    <dd data-testid="total-plan">{money(moneyOf(data.totals.money, 'PLAN_IN_FORCE'))}</dd>
                  </div>
                  <div>
                    <dt>{t('ent3a.detail.totals.ytd')}</dt>
                    <dd data-testid="total-ytd">{money(moneyOf(data.totals.money, 'CUMULATIVE_YTD'))}</dd>
                  </div>
                  <div>
                    <dt>{t('ent3a.detail.totals.rateYear')}</dt>
                    <dd>
                      <RateText rate={rateOf(data.totals.rates, 'RATE_YEAR_IN_FORCE')} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t('ent3a.detail.totals.tmdt')}</dt>
                    <dd>{money(data.totals.total_investment_vnd)}</dd>
                  </div>
                </dl>
                <SinceStartTile
                  ratePct={data.totals.rate_since_start.ratePct}
                  nullReason={data.totals.rate_since_start.nullReason}
                  numerator={moneyOf(data.totals.money, 'CUMULATIVE_SINCE_START')}
                  denominator={data.totals.total_investment_vnd}
                  asOf={asOf}
                  packCode={data.pack.code}
                  version={version}
                  unverified={data.snapshot.definition_status === 'PROPOSED_PENDING_SIGNOFF'}
                />
                <ul className="dis-ent-lineage" data-testid="by-class">
                  {data.totals.by_class.map((one) => (
                    <li key={one.class_code}>{t('ent3a.detail.byClass', { class: one.class_code, plan: money(moneyOf(one.money, 'PLAN_IN_FORCE', one.class_code)), ytd: money(moneyOf(one.money, 'CUMULATIVE_YTD', one.class_code)) })}</li>
                  ))}
                </ul>
              </SectionCard>
              <SectionCard title={t('ent3a.detail.units.title')}>
                <DataTable<UnitRow> caption={t('ent3a.detail.units.caption')} columns={unitColumns} rows={data.by_unit} rowKey={(row) => row.unit_id} />
              </SectionCard>
              <SectionCard title={t('ent3a.detail.projects.title')}>
                <DataTable<ProjectRow> caption={t('ent3a.detail.projects.caption')} columns={projectColumns} rows={data.projects} rowKey={(row) => row.project_id} />
              </SectionCard>
              <SectionCard title={t('ent3a.detail.indicators.title')}>
                {data.indicators.length === 0 ? (
                  <p data-testid="no-indicators">{t('ent3a.detail.indicators.none')}</p>
                ) : (
                  <DataTable<IndicatorRow> caption={t('ent3a.detail.indicators.caption')} columns={indicatorColumns} rows={data.indicators} rowKey={(row) => `${row.project_code}/${row.indicator_code}`} />
                )}
              </SectionCard>
              <SectionCard title={t('ent3a.detail.lineage.title')}>
                <DataTable<LineageRow> caption={t('ent3a.detail.lineage.caption')} columns={lineageColumns} rows={data.lineage} rowKey={(row) => row.id} />
                <div className="sub">
                  {data.pack.measures.map((one) => (
                    <button
                      key={one}
                      type="button"
                      className="ui-button ui-button--outline"
                      aria-pressed={data.measure === one}
                      onClick={() => {
                        const next = new URLSearchParams(params);
                        next.set('measure', one);
                        setParams(next, { replace: true });
                      }}
                    >
                      {t(`dis.funding.measure.${camel(one)}`)}
                    </button>
                  ))}
                </div>
              </SectionCard>
            </>
          )}
        </StateBoundary>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('ent3a.detail.confirm.title')}
        context={[
          { label: t('ent3a.detail.ctx.period'), value: data?.snapshot.period_code ?? NONE },
          { label: t('ent3a.detail.ctx.revision'), value: String(data?.snapshot.revision ?? 0) },
        ]}
        confirmLabel={t('ent3a.detail.action.freeze')}
        cancelLabel={t('ent3a.action.cancel')}
        pending={freeze.isPending}
        {...(problem === undefined ? {} : { error: t(`ent3a.detail.problem.${problem}`) })}
        onConfirm={confirm}
        onCancel={cancel}
      >
        <p>{t('ent3a.detail.confirm.note')}</p>
      </ConfirmDialog>
      <p className="prototype-note">{t('ent3a.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
