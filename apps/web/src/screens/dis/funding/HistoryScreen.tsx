import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import '../dis.css';
import { Banner } from './components';
import { useHistory, useTaxonomy } from './hooks';
import { BATCH_PATH, BOARD_PATH, NONE, camel, money } from './model';
import type { Grain, HistoryEntry } from './model';
import './funding.css';

interface FundingHistoryLike {
  history: unknown[];
  pending: unknown[];
}

/**
 * DIS-29: the transition history of one period of one figure (FND-1, docs/fnd-funding-model.md 7.3): the estimates in the order of the day they were known from, then the actual that replaced them, each step linked to the one
 * before it, with the change between two estimates and the difference between the actual and the estimate it replaced. The history is append-only: nothing on this screen can be edited or deleted. The batches that still wait
 * are shown apart and are not part of the history until somebody accepts them.
 */
export default function HistoryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <HistoryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HistoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const taxonomy = useTaxonomy();
  const projectId = params.get('project');
  const classCode = params.get('class');
  const tierCode = params.get('tier');
  const measure = params.get('measure');
  const grain = params.get('grain');
  const planYear = Number(params.get('year'));
  const ordinal = Number(params.get('ordinal'));
  const complete = projectId !== null && classCode !== null && tierCode !== null && measure !== null && grain !== null && Number.isInteger(planYear) && planYear > 0 && Number.isInteger(ordinal) && ordinal > 0;
  const history = useHistory(complete ? { projectId, classCode, tierCode, measure, grain, planYear, ordinal } : undefined);
  const state = useScreenState({ isLoading: taxonomy.isLoading || (complete && history.isLoading), error: complete ? (history.error ?? taxonomy.error) : taxonomy.error, data: complete ? history.data : [], isEmpty: (data) => !Array.isArray(data) && (data as FundingHistoryLike).history.length === 0 && (data as FundingHistoryLike).pending.length === 0 });
  const data = history.data;
  const entries = data?.history ?? [];
  const waiting = data?.pending ?? [];
  const classes = taxonomy.data?.classes ?? [];
  const columns: DataTableColumn<HistoryEntry>[] = [
    { key: 'kind', header: t('dis.funding.col.kind'), render: (row) => t(`dis.funding.kind.${camel(row.figure_kind)}`) },
    { key: 'asOf', header: t('dis.funding.col.asOf'), render: (row) => row.as_of_date },
    { key: 'revision', header: t('dis.funding.col.revision'), align: 'right', render: (row) => String(row.revision) },
    { key: 'amount', header: t('dis.funding.col.amount'), align: 'right', render: (row) => money(row.amount_vnd) },
    { key: 'change', header: t('dis.funding.col.change'), align: 'right', render: (row) => money(row.change_vnd) },
    { key: 'replaced', header: t('dis.funding.col.replaced'), align: 'right', render: (row) => (row.estimate_amount_vnd === null ? NONE : money(row.estimate_amount_vnd)) },
    { key: 'delta', header: t('dis.funding.col.delta'), align: 'right', render: (row) => money(row.conversion_delta_vnd) },
    { key: 'basis', header: t('dis.funding.col.basis'), render: (row) => t(`dis.funding.basis.${camel(row.basis)}`) },
    { key: 'status', header: t('dis.funding.col.status'), render: (row) => <StatusPill tone={row.status === 'ACCEPTED' ? 'success' : 'neutral'}>{t(`dis.funding.batch.status.${camel(row.status)}`)}</StatusPill> },
    { key: 'reason', header: t('dis.funding.col.reason'), render: (row) => (row.conversion_reason === null ? NONE : t(`dis.funding.conversion.${camel(row.conversion_reason)}`)) },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.funding.history.title')}</h1>
          <p>{t('dis.funding.history.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={BOARD_PATH}>
          {t('dis.funding.history.toBoard')}
        </Link>
      </div>
      {complete ? (
        <ContextBar
          items={[
            { label: t('dis.funding.col.project'), value: data?.project_code ?? NONE },
            { label: t('dis.funding.col.class'), value: classes.find((one) => one.code === classCode)?.label ?? classCode },
            { label: t('dis.funding.col.period'), value: t(`dis.funding.period.${camel(grain as Grain)}`, { n: ordinal }) + ` / ${planYear}` },
          ]}
          asOf={data?.as_of}
        />
      ) : (
        <Banner tone="info" testId="missing-key">
          {t('dis.funding.history.missing')}
        </Banner>
      )}
      <StateBoundary state={complete ? state : 'default'} onRetry={() => void history.refetch()}>
        {complete ? (
          <>
            <SectionCard title={t('dis.funding.history.table.title')}>
              <DataTable<HistoryEntry> caption={t('dis.funding.history.caption')} columns={columns} rows={entries} rowKey={(row) => row.id} emptyKind="none" />
              <p className="dis-funding-note">{t('dis.funding.history.appendOnly')}</p>
            </SectionCard>
            {waiting.length === 0 ? null : (
              <SectionCard title={t('dis.funding.history.pending.title')}>
                <ul data-testid="pending">
                  {waiting.map((one) => (
                    <li key={`${one.batch_id}-${one.period_ordinal}`}>
                      {t(`dis.funding.kind.${camel(one.figure_kind)}`)} · {money(one.amount_vnd)} · {t(`dis.funding.batch.status.${camel(one.status)}`)} · {one.as_of_date}
                    </li>
                  ))}
                </ul>
                <Link to={`${BATCH_PATH}?status=SUBMITTED`}>{t('dis.funding.history.toBatches')}</Link>
              </SectionCard>
            )}
          </>
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('dis.funding.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
