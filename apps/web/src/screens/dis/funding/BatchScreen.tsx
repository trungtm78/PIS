import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, MakerCheckerBadge, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { Field } from '../components';
import '../dis.css';
import { BatchForm } from './BatchForm';
import { Banner } from './components';
import { useAccept, useBatches, useReturn, useSubmit, useTaxonomy, useWithdraw } from './hooks';
import { ACCEPT_PERMISSION, BATCH_STATUSES, BOARD_PATH, HISTORY_PATH, MIN_REASON, NONE, PREPARE_PERMISSION, describeProblem, money, camel } from './model';
import type { BatchStatus, FundingBatch } from './model';
import './funding.css';

type Pending = { kind: 'return' | 'withdraw'; batch: FundingBatch } | undefined;

const TONES: Readonly<Record<BatchStatus, Tone>> = { DRAFT: 'neutral', SUBMITTED: 'info', ACCEPTED: 'success', SUPERSEDED: 'neutral', WITHDRAWN: 'warning' };

/**
 * DIS-28: the batches of figures (FND-1, docs/fnd-funding-model.md 7.3 and 8): the person who prepares writes the phasing of the plan, an estimate, an actual or a late adjustment as a draft, hands it in, or takes it back;
 * somebody else accepts it or sends it back with a reason (maker is not checker; the person who prepared never sees the buttons that accept). Accepting an actual replaces the estimate it follows, in one step, and the
 * history keeps both (DIS-29). A batch is never deleted.
 */
export default function BatchScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BatchContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BatchContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const taxonomy = useTaxonomy();
  const batches = useBatches({ ...(status === '' ? {} : { status }) });
  const submit = useSubmit();
  const accept = useAccept();
  const sendBack = useReturn();
  const withdraw = useWithdraw();
  const [pending, setPending] = useState<Pending>(undefined);
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;
  const canPrepare = holds(PREPARE_PERMISSION);
  const canAccept = holds(ACCEPT_PERMISSION);
  const state = useScreenState({ isLoading: batches.isLoading || taxonomy.isLoading, error: batches.error ?? taxonomy.error, data: batches.data, isEmpty: (data) => (data as unknown[]).length === 0 });
  const failure = [submit, accept, sendBack, withdraw].map((one) => one.error).find((one) => one !== null && one !== undefined);
  const problem = failure === undefined ? undefined : describeProblem(failure);
  const classes = taxonomy.data?.classes ?? [];
  const waiting = (batches.data ?? []).filter((one) => one.status === 'SUBMITTED').length;

  const columns: DataTableColumn<FundingBatch>[] = [
    { key: 'project', header: t('dis.funding.col.project'), pinned: true, render: (row) => row.project_code },
    { key: 'class', header: t('dis.funding.col.class'), render: (row) => classes.find((one) => one.code === row.class_code)?.label ?? row.class_code },
    { key: 'kind', header: t('dis.funding.col.kind'), render: (row) => t(`dis.funding.kind.${camel(row.figure_kind)}`) },
    { key: 'period', header: t('dis.funding.col.period'), render: (row) => `${t(`dis.funding.grain.${camel(row.period_grain)}`)} ${row.plan_year}` },
    {
      key: 'entries',
      header: t('dis.funding.col.entries'),
      align: 'right',
      render: (row) => (
        <span>
          {row.entries.map((entry) => `${entry.period_ordinal === 0 ? row.plan_year : entry.period_ordinal}: ${money(entry.amount_vnd)}`).join(' · ')}
        </span>
      ),
    },
    { key: 'asOf', header: t('dis.funding.col.asOf'), render: (row) => row.as_of_date },
    { key: 'status', header: t('dis.funding.col.status'), render: (row) => <StatusPill tone={TONES[row.status as BatchStatus]}>{t(`dis.funding.batch.status.${camel(row.status)}`)}</StatusPill> },
    { key: 'maker', header: t('dis.funding.col.maker'), render: (row) => <MakerCheckerBadge maker={row.prepared_by_me ? t('dis.funding.maker.me') : t('dis.funding.maker.other')} checker={row.approved_at === null || row.approved_at === undefined ? null : t('dis.funding.maker.checked')} /> },
    {
      key: 'actions',
      header: t('dis.funding.col.actions'),
      render: (row) => {
        const actions = row.actions;
        return (
          <span className="dis-funding-row-actions">
            {actions.submit ? (
              <button type="button" className="ui-button ui-button--small" disabled={!canPrepare || submit.isPending} onClick={() => submit.mutate({ batchId: row.batch_id, version: row.version })}>
                {t('dis.funding.action.submit')}
              </button>
            ) : null}
            {actions.accept ? (
              <button type="button" className="ui-button ui-button--small" disabled={!canAccept || accept.isPending} onClick={() => accept.mutate({ batchId: row.batch_id, version: row.version })}>
                {t('dis.funding.action.accept')}
              </button>
            ) : null}
            {actions.return ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!canAccept} onClick={() => setPending({ kind: 'return', batch: row })}>
                {t('dis.funding.action.return')}
              </button>
            ) : null}
            {actions.withdraw ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!canPrepare} onClick={() => setPending({ kind: 'withdraw', batch: row })}>
                {t('dis.funding.action.withdraw')}
              </button>
            ) : null}
            <Link to={`${HISTORY_PATH}?project=${row.project_id}&class=${row.class_code}&tier=${row.tier_code}&measure=${row.measure}&grain=${row.period_grain === 'YEAR' ? 'MONTH' : row.period_grain}&year=${row.plan_year}&ordinal=${(row.entries[0]?.period_ordinal ?? 0) || 1}`}>{t('dis.funding.row.history')}</Link>
          </span>
        );
      },
    },
  ];

  const confirm = (reason?: string): void => {
    if (pending === undefined || reason === undefined) return;
    const input = { batchId: pending.batch.batch_id, version: pending.batch.version, reason };
    const done = { onSuccess: () => setPending(undefined) };
    if (pending.kind === 'return') sendBack.mutate(input, done);
    else withdraw.mutate(input, done);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.funding.batch.title')}</h1>
          <p>{t('dis.funding.batch.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={BOARD_PATH}>
          {t('dis.funding.batch.toBoard')}
        </Link>
      </div>
      <ContextBar items={[{ label: t('dis.funding.ctx.waiting'), value: batches.data === undefined ? NONE : String(waiting) }]} />
      {!canPrepare && !canAccept ? (
        <Banner tone="info" testId="read-only">
          {frozen ? t('dis.funding.readOnly.frozen.notice') : t('dis.funding.readOnly.denied.notice')}
        </Banner>
      ) : null}
      {problem === undefined ? null : (
        <Banner tone="warning" testId="problem">
          {t(`dis.funding.problem.${camel(problem)}`)}
        </Banner>
      )}
      {canPrepare && taxonomy.data !== undefined ? <BatchForm taxonomy={taxonomy.data} onSaved={() => void batches.refetch()} /> : null}
      <SectionCard title={t('dis.funding.batch.list.title')}>
        <Field id="fnd-status" label={t('dis.funding.filter.status')} error={undefined}>
          <select
            id="fnd-status"
            value={status}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value === '') next.delete('status');
              else next.set('status', event.target.value);
              setParams(next, { replace: true });
            }}
          >
            <option value="">{t('dis.funding.filter.status.all')}</option>
            {BATCH_STATUSES.map((one) => (
              <option key={one} value={one}>
                {t(`dis.funding.batch.status.${camel(one)}`)}
              </option>
            ))}
          </select>
        </Field>
        <StateBoundary state={state} onRetry={() => void batches.refetch()}>
          <DataTable<FundingBatch> caption={t('dis.funding.batch.caption')} columns={columns} rows={batches.data ?? []} rowKey={(row) => row.batch_id} />
        </StateBoundary>
      </SectionCard>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending?.kind === 'return' ? t('dis.funding.return.title') : t('dis.funding.withdraw.title')}
        context={pending === undefined ? [] : [{ label: t('dis.funding.col.project'), value: pending.batch.project_code }, { label: t('dis.funding.col.kind'), value: t(`dis.funding.kind.${camel(pending.batch.figure_kind)}`) }]}
        confirmLabel={pending?.kind === 'return' ? t('dis.funding.action.return') : t('dis.funding.action.withdraw')}
        cancelLabel={t('dis.funding.action.cancel')}
        reason={{ label: t('dis.funding.reason.label'), required: true, minLength: MIN_REASON, hint: t('dis.funding.reason.hint', { min: MIN_REASON }) }}
        pending={sendBack.isPending || withdraw.isPending}
        onConfirm={confirm}
        onCancel={() => setPending(undefined)}
      />
      <p className="prototype-note">{t('dis.funding.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
