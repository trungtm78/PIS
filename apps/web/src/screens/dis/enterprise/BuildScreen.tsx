import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Field } from '../components';
import '../dis.css';
import { Banner } from '../funding/components';
import { useBuild, useReadiness, useSnapshots } from './hooks';
import { MissingUnits, STATUS_TONES, SnapshotLink, WaitingBatches } from './components';
import { BUILD_PERMISSION, DETAIL_PATH, NONE, REOPEN_PATH, camel, describeProblem, missingUnitsOf, shortHash, waitingBatchesOf } from './model';
import type { Snapshot } from './model';
import { usePeriods } from '../hooks';
import { statusLabel } from '../labels';
import './enterprise.css';

/**
 * DIS-32: build and review the enterprise period snapshot (ENT-3a, docs/ent-snapshot.md; DL.03, R17, R21). The person picks a period; the screen says whether every planned cell has its accepted actual (and, if not,
 * which units, projects, cells and months are missing and which batches still wait for acceptance), shows the snapshot that is already frozen (revision and hash) and whether a rebuild is allowed (it is after an approved
 * reopening of the period), and offers the build (a confirmation first). The snapshots of the period are listed and open in DIS-33.
 */
export default function BuildScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BuildContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BuildContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const periodId = params.get('period') ?? undefined;
  const periods = usePeriods();
  const readiness = useReadiness(periodId);
  const snapshots = useSnapshots(periodId);
  const build = useBuild();
  const [confirming, setConfirming] = useState(false);
  const frozenMode = mode === 'READ_ONLY';
  const canBuild = (permissions === undefined || permissions.includes(BUILD_PERMISSION)) && !frozenMode;
  const state = useScreenState({ isLoading: readiness.isLoading, error: readiness.error, data: readiness.data });
  const listState = useScreenState({ isLoading: snapshots.isLoading, error: snapshots.error, data: snapshots.data, isEmpty: (data) => (data as unknown[]).length === 0 });
  const ready = readiness.data;
  const problem = build.error === null ? undefined : describeProblem(build.error);
  const refusedUnits = missingUnitsOf(build.error);
  const refusedBatches = waitingBatchesOf(build.error);
  const created = (build.data as { resource_id?: string } | undefined)?.resource_id;
  const options = [...(periods.data ?? [])].sort((left, right) => right.startDate.localeCompare(left.startDate));
  const canStart = ready !== undefined && ready.actions.build && ready.complete && (ready.frozen === null || ready.rebuild_allowed);

  const columns: DataTableColumn<Snapshot>[] = [
    { key: 'revision', header: t('ent3a.build.col.revision'), align: 'right', pinned: true, render: (row) => String(row.revision) },
    { key: 'status', header: t('ent3a.build.col.status'), render: (row) => <StatusPill tone={STATUS_TONES[row.status]}>{t(`ent3a.status.${camel(row.status)}`)}</StatusPill> },
    { key: 'hash', header: t('ent3a.build.col.hash'), render: (row) => <span className="dis-ent-hash" title={row.payload_sha256 ?? undefined}>{shortHash(row.payload_sha256)}</span> },
    { key: 'asOf', header: t('ent3a.build.col.asOf'), render: (row) => row.as_of_date ?? NONE },
    { key: 'rows', header: t('ent3a.build.col.rows'), align: 'right', render: (row) => String(row.row_count) },
    { key: 'frozenAt', header: t('ent3a.build.col.frozenAt'), render: (row) => row.frozen_at ?? NONE },
    { key: 'open', header: t('ent3a.build.col.open'), render: (row) => <SnapshotLink id={row.id}>{t('ent3a.build.row.open')}</SnapshotLink> },
  ];

  const confirm = (): void => {
    if (periodId === undefined) return;
    build.mutate({ periodId }, { onSuccess: () => setConfirming(false) });
  };
  const cancel = (): void => {
    setConfirming(false);
    build.reset();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ent3a.build.title')}</h1>
          <p>{t('ent3a.build.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={REOPEN_PATH}>
          {t('ent3a.build.toReopen')}
        </Link>
      </div>
      <SectionCard title={t('ent3a.build.period.title')}>
        <Field id="ent-period" label={t('ent3a.build.period.label')} error={undefined}>
          <select
            id="ent-period"
            value={periodId ?? ''}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value === '') next.delete('period');
              else next.set('period', event.target.value);
              setParams(next, { replace: true });
              build.reset();
            }}
          >
            <option value="">{t('ent3a.build.period.choose')}</option>
            {options.map((one) => (
              <option key={one.id} value={one.id}>
                {t('ent3a.build.period.option', { code: one.code, status: statusLabel(t, one.status) })}
              </option>
            ))}
          </select>
        </Field>
        {periods.isError ? <Banner tone="warning" testId="periods-failed">{t('ent3a.build.period.failed')}</Banner> : null}
      </SectionCard>
      {periodId === undefined ? (
        <p className="sub" data-testid="no-period">
          {t('ent3a.build.period.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void readiness.refetch()}>
          {ready === undefined ? null : (
            <>
              <ContextBar
                items={[
                  { label: t('ent3a.build.ctx.period'), value: `${ready.period.code} · ${statusLabel(t, ready.period.status as 'OPEN' | 'SOFT_CLOSED' | 'LOCKED')}` },
                  { label: t('ent3a.build.ctx.pack'), value: t('ent3a.build.ctx.packValue', { pack: ready.pack.code, version: ready.pack.version }) },
                  { label: t('ent3a.build.ctx.planned'), value: t('ent3a.build.ctx.plannedValue', { cells: ready.planned_cells, projects: ready.projects }) },
                ]}
              />
              {ready.pack.unverified ? <Banner tone="warning" testId="unverified">{t('ent3a.unverified.notice')}</Banner> : null}
              {frozenMode ? <Banner tone="info" testId="read-only">{t('ent3a.readOnly.frozen.notice')}</Banner> : null}
              {!canBuild && !frozenMode ? <Banner tone="info" testId="read-only">{t('ent3a.readOnly.denied.notice')}</Banner> : null}
              <SectionCard
                title={t('ent3a.build.ready.title')}
                status={<StatusPill tone={ready.complete ? 'success' : 'warning'}>{ready.complete ? t('ent3a.build.ready.complete') : t('ent3a.build.ready.incomplete')}</StatusPill>}
              >
                {ready.complete ? <p data-testid="complete">{t('ent3a.build.ready.completeNote')}</p> : <MissingUnits units={ready.missing_units} />}
                <WaitingBatches batches={ready.waiting_batches} />
                {ready.frozen === null ? (
                  <p data-testid="not-frozen">{t('ent3a.build.frozen.none')}</p>
                ) : (
                  <dl className="dis-ent-facts" data-testid="frozen">
                    <div>
                      <dt>{t('ent3a.build.frozen.revision')}</dt>
                      <dd>{ready.frozen.revision}</dd>
                    </div>
                    <div>
                      <dt>{t('ent3a.build.frozen.hash')}</dt>
                      <dd className="dis-ent-hash">{ready.frozen.payload_sha256}</dd>
                    </div>
                    <div>
                      <dt>{t('ent3a.build.frozen.open')}</dt>
                      <dd>
                        <Link to={`${DETAIL_PATH}?snapshot=${ready.frozen.id}`}>{t('ent3a.build.row.open')}</Link>
                      </dd>
                    </div>
                  </dl>
                )}
                {ready.frozen !== null ? (
                  ready.rebuild_allowed ? (
                    <Banner tone="info" testId="rebuild-allowed">{t('ent3a.build.rebuild.allowed')}</Banner>
                  ) : (
                    <Banner tone="info" testId="rebuild-needs-reopen">
                      {t('ent3a.build.rebuild.needsReopen')} <Link to={REOPEN_PATH}>{t('ent3a.build.toReopen')}</Link>
                    </Banner>
                  )
                ) : null}
                {ready.period.status === 'OPEN' ? <Banner tone="info" testId="not-locked">{t('ent3a.build.problem.notLocked')}</Banner> : null}
                {created === undefined ? null : (
                  <Banner tone="info" testId="built">
                    {t('ent3a.build.built')} <SnapshotLink id={created}>{t('ent3a.build.row.open')}</SnapshotLink>
                  </Banner>
                )}
                {problem === undefined || confirming ? null : (
                  <Banner tone="warning" testId="problem">
                    {t(`ent3a.build.problem.${problem}`)}
                    {problem === 'frozen' ? (
                      <>
                        {' '}
                        <Link to={REOPEN_PATH}>{t('ent3a.build.toReopen')}</Link>
                      </>
                    ) : null}
                  </Banner>
                )}
                {problem === 'incomplete' && ready.complete ? (
                  <>
                    <MissingUnits units={refusedUnits} />
                    <WaitingBatches batches={refusedBatches} />
                  </>
                ) : null}
                {ready.actions.build ? (
                  <div className="dis-ent-actions">
                    <button type="button" className="ui-button" disabled={!canBuild || !canStart || build.isPending} onClick={() => setConfirming(true)}>
                      {t('ent3a.build.action.build')}
                    </button>
                    {!ready.complete ? <small className="sub">{t('ent3a.build.action.blockedIncomplete')}</small> : null}
                    {ready.complete && ready.frozen !== null && !ready.rebuild_allowed ? <small className="sub">{t('ent3a.build.action.blockedFrozen')}</small> : null}
                  </div>
                ) : null}
              </SectionCard>
              <SectionCard title={t('ent3a.build.list.title')}>
                <StateBoundary state={listState} onRetry={() => void snapshots.refetch()}>
                  <DataTable<Snapshot> caption={t('ent3a.build.list.caption')} columns={columns} rows={snapshots.data ?? []} rowKey={(row) => row.id} />
                </StateBoundary>
              </SectionCard>
            </>
          )}
        </StateBoundary>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('ent3a.build.confirm.title')}
        context={[
          { label: t('ent3a.build.ctx.period'), value: ready?.period.code ?? NONE },
          { label: t('ent3a.build.ctx.pack'), value: ready === undefined ? NONE : t('ent3a.build.ctx.packValue', { pack: ready.pack.code, version: ready.pack.version }) },
          { label: t('ent3a.build.frozen.revision'), value: String((ready?.frozen?.revision ?? 0) + 1) },
        ]}
        confirmLabel={t('ent3a.build.action.build')}
        cancelLabel={t('ent3a.action.cancel')}
        pending={build.isPending}
        {...(problem === undefined ? {} : { error: t(`ent3a.build.problem.${problem}`) })}
        onConfirm={confirm}
        onCancel={cancel}
      >
        <p>{t('ent3a.build.confirm.note')}</p>
      </ConfirmDialog>
      <p className="prototype-note">{t('ent3a.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
