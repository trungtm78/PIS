import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Figure, InfoRule, dong, useRead, vietnamDay, vietnamDateTime } from '../docaud-support';
import '../docaud.css';
import type { Profile, Standing, StandingList } from './audModel';

/**
 * AUD-17, the order in which to follow up the audit recommendations of the investors (G4-10). The score is the overdue, disputed and open recommendations and the money still owed, each with the weight of the rule (not confirmed);
 * it is a standing for follow-up, never a verdict. The place in the disbursement ranking is shown beside it and mixed into nothing; the red flags of procurement, which are confidential, are not here.
 */
export default function InvestorStandingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <StandingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function StandingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const unit = params.get('unit') ?? undefined;
  const list = useRead<StandingList>('listInvestorStandings');
  const profile = useRead<Profile>('getInvestorProfile', { path: { unit_id: unit ?? '' } }, unit !== undefined);
  const query = unit === undefined ? list : profile;
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => unit === undefined && (value as StandingList).items.length === 0 });
  const refreshFailed = query.isError && data !== undefined;
  const asOf = data?.as_of ?? '';
  const rule = data?.rule;
  const rankColumn = (row: Standing): string => (row.follow_up_rank === null ? t('gov12da.aud17.rank.none') : String(row.follow_up_rank));
  const disbursement = (row: Standing): string => (row.disbursement_rank === null ? t('gov12da.aud17.disbursement.none') : t('gov12da.aud17.disbursement.text', { rank: row.disbursement_rank, rate: row.disbursement_rate_pct ?? '–' }));

  const columns: DataTableColumn<Standing>[] = [
    { key: 'unit', header: t('gov12da.aud17.col.unit'), pinned: true, render: (row) => (unit === undefined ? <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${row.unit_id}`} onClick={() => void navigate(`/aud/aud-17?unit=${row.unit_id}`)}>{row.unit_name ?? row.unit_code ?? row.unit_id}</button> : <strong>{row.unit_name ?? row.unit_code ?? row.unit_id}</strong>) },
    { key: 'rank', header: t('gov12da.aud17.col.rank'), align: 'right', render: (row) => <span data-testid={`rank-${row.unit_id}`}>{rankColumn(row)}</span> },
    { key: 'score', header: t('gov12da.aud17.col.score'), align: 'right', render: (row) => <>{row.score} <InfoRule topic="standing" name={t('gov12da.aud17.col.score')} asOf={asOf} rule={rule} /></> },
    { key: 'overdue', header: t('gov12da.aud17.col.overdue'), align: 'right', render: (row) => row.overdue },
    { key: 'disputed', header: t('gov12da.aud17.col.disputed'), align: 'right', render: (row) => row.disputed },
    { key: 'open', header: t('gov12da.aud17.col.open'), align: 'right', render: (row) => row.open },
    { key: 'owed', header: t('gov12da.aud17.col.owed'), align: 'right', render: (row) => <>{dong(row.owed_vnd)} <InfoRule topic="standing" name={t('gov12da.aud17.col.owed')} asOf={asOf} rule={rule} /></> },
    { key: 'disbursement', header: t('gov12da.aud17.col.disbursement'), render: (row) => <span data-testid={`disbursement-${row.unit_id}`}>{disbursement(row)}</span> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov12da.aud17.page.title')}</h1>
          <p>{t('gov12da.aud17.page.subtitle')}</p>
        </div>
        {unit === undefined ? null : <button type="button" className="ui-button ui-button--outline" data-testid="back" onClick={() => void navigate('/aud/aud-17')}>{t('gov12da.aud17.back')}</button>}
      </div>
      <ContextBar
        items={[
          { label: t('gov12da.common.context.scope'), value: tenant?.name ?? '–' },
          { label: t('gov12da.aud17.context.ranking'), value: data === undefined || data.ranking_as_of === null ? t('gov12da.aud17.context.noRanking') : vietnamDay(data.ranking_as_of) },
        ]}
        {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })}
        stale={refreshFailed}
      />
      <p className="callout" role="note" data-testid="standing-note">{t('gov12da.aud17.note.text')}</p>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {unit === undefined && list.data !== undefined ? (
          <>
            <div className="g12-figures">
              <Figure label={t('gov12da.aud17.figure.ranked')} value={String(list.data.items.filter((row) => row.follow_up_rank !== null).length)} topic="standing" asOf={asOf} rule={rule} testId="figure-ranked" />
              <Figure label={t('gov12da.aud17.figure.weights')} value={t('gov12da.aud17.weights.text', { overdue: list.data.rule.weights.overdue, disputed: list.data.rule.weights.disputed, open: list.data.rule.weights.open })} topic="standing" asOf={asOf} rule={rule} testId="figure-weights" />
            </div>
            <DataTable caption={t('gov12da.aud17.table.caption')} columns={columns} rows={list.data.items} rowKey={(row) => row.unit_id} />
          </>
        ) : null}
        {unit !== undefined && profile.data !== undefined ? (
          <>
            <DataTable caption={t('gov12da.aud17.profile.caption')} columns={columns} rows={[profile.data]} rowKey={(row) => row.unit_id} />
            <p className="g12-muted" data-testid="profile-of">{t('gov12da.aud17.profile.of', { rank: profile.data.follow_up_rank ?? '–', total: profile.data.ranked_units })}</p>
            <h2>{t('gov12da.aud17.recs.title')}</h2>
            <DataTable
              caption={t('gov12da.aud17.recs.caption')}
              rows={profile.data.recommendations}
              rowKey={(row) => row.id}
              columns={[
                { key: 'code', header: t('gov12da.aud17.rcol.code'), pinned: true, render: (row) => row.code },
                { key: 'status', header: t('gov12da.aud17.rcol.status'), render: (row) => <StatusPill tone={row.overdue ? 'danger' : row.status === 'CLOSED' ? 'success' : 'neutral'}>{t(`gov12da.aud17.status.${row.status.toLowerCase().replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())}`)}</StatusPill> },
                { key: 'due', header: t('gov12da.aud17.rcol.due'), render: (row) => <span data-testid={`due-${row.id}`}>{vietnamDay(row.due_on)}{row.overdue ? <> <StatusPill tone="danger">{t('gov12da.aud17.rcol.late')}</StatusPill></> : null}</span> },
                { key: 'amount', header: t('gov12da.aud17.rcol.amount'), align: 'right', render: (row) => dong(row.amount_vnd) },
                { key: 'recovered', header: t('gov12da.aud17.rcol.recovered'), align: 'right', render: (row) => dong(row.recovered_vnd) },
              ]}
            />
          </>
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('gov12da.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

