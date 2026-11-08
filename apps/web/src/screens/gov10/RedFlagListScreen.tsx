import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { RED_FLAG_BANDS, RED_FLAG_STATUSES, redFlagEmptyKind } from './model';
import type { Finding, RedFlagBand, RedFlagStatus } from './model';
import { RED_FLAG_PAGE, useRedFlagSummary, useRedFlags, useScanRedFlags } from './hooks';
import { BandPill, Pager, Provenance, bandLabel, indicatorLabel, redStatusLabel, when } from './parts';

const SCAN_PERMISSION = 'aud.redflag.scan';

/**
 * AUD-14: the procurement red flags, ranked so that the auditors look where the signals pile up. It is a signal for review and never a conclusion (the notice is always on the page), it is for the auditors only (a person who
 * took part in a procurement never sees its finding or a count that includes it), and an indicator whose input is missing says so instead of being shown as clear. The empty list says whether a scan has finished, so that
 * "no signals" is never said for want of a scan.
 */
export default function RedFlagListScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <RedFlagListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RedFlagListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const session = useSession();
  const [status, setStatus] = useState<RedFlagStatus | ''>('');
  const [band, setBand] = useState<RedFlagBand | ''>('');
  const [offset, setOffset] = useState(0);
  const list = useRedFlags({ status: status === '' ? undefined : status, band: band === '' ? undefined : band, offset });
  const summary = useRedFlagSummary();
  const scan = useScanRedFlags();
  const answer = list.data;
  const state = useScreenState({ isLoading: list.isLoading, error: answer === undefined ? list.error : undefined, data: answer, isEmpty: () => false });
  const stale = answer !== undefined && list.isError;
  const items = answer?.items ?? [];
  const filtered = status !== '' || band !== '';
  const canScan = session.permissions?.includes(SCAN_PERMISSION) === true;
  const lastScan = summary.data?.lastScan ?? null;

  const columns: DataTableColumn<Finding>[] = [
    {
      key: 'subject',
      header: t('gov10.red.column.subject'),
      pinned: true,
      render: (row) => (
        <>
          <Link to={`/aud/aud-15?finding=${row.id}`}>{row.subjectCode}</Link>
          <span className="dis-code">{row.subjectType === 'PACKAGE' ? t('gov10.red.subject.package') : t('gov10.red.subject.contract')}</span>
        </>
      ),
    },
    {
      key: 'score',
      header: t('gov10.red.column.score'),
      align: 'right',
      render: (row) => (
        <>
          <strong data-testid={`score-${row.id}`}>{row.score}</strong> <BandPill band={row.band} />
        </>
      ),
    },
    {
      key: 'fired',
      header: t('gov10.red.column.fired'),
      render: (row) => (
        <span className="gov10-chips">
          {row.fired.map((entry) => (
            <StatusPill key={entry.code} tone="neutral">
              {entry.ocpId === null ? '' : `${entry.ocpId} `}
              {indicatorLabel(t, entry.code)}
            </StatusPill>
          ))}
        </span>
      ),
    },
    {
      key: 'missing',
      header: t('gov10.red.column.missing'),
      align: 'right',
      render: (row) => (row.notComputable.length === 0 ? '—' : t('gov10.red.missingCount', { count: row.notComputable.length })),
    },
    { key: 'status', header: t('gov10.red.column.status'), render: (row) => redStatusLabel(t, row.status) },
    { key: 'evaluated', header: t('gov10.red.column.evaluated'), render: (row) => <time dateTime={row.lastEvaluatedAt}>{when(row.lastEvaluatedAt)}</time> },
  ];

  const emptyKind = redFlagEmptyKind(summary.data);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov10.red.title')}</h1>
          <p>{t('gov10.red.subtitle')}</p>
        </div>
        {canScan ? (
          <button type="button" className="mv-alert-button" disabled={scan.isPending} onClick={() => scan.mutate({})} data-testid="scan-now">
            {scan.isPending ? t('gov10.red.scanning') : t('gov10.red.scanNow')}
          </button>
        ) : null}
      </div>
      <div className="gov10-stack">
        <p className="gov10-notice" data-testid="red-flag-notice">
          {t('gov10.red.notice')}
        </p>
        {scan.isError ? (
          <p className="gov10-notice gov10-notice--warn" role="alert" data-testid="scan-error">
            {t('gov10.red.scanFailed')}
          </p>
        ) : null}
        <ContextBar
          items={[
            { label: t('gov10.red.ctx.total'), value: String(summary.data?.total ?? 0) },
            { label: t('gov10.red.ctx.high'), value: String(summary.data?.byBand.HIGH ?? 0) },
            { label: t('gov10.red.ctx.lastScan'), value: lastScan === null ? t('gov10.red.ctx.never') : when(lastScan.finishedAt ?? lastScan.startedAt) },
            { label: t('gov10.red.ctx.ranking'), value: items[0]?.rankingVersion ?? t('gov10.red.ctx.rankingNone') },
          ]}
          {...(answer === undefined || answer.asOf === '' ? {} : { asOf: when(answer.asOf) })}
          stale={stale}
        />
        <div className="gov10-filters" role="search" aria-label={t('gov10.red.filters')}>
          <label>
            <span>{t('gov10.red.filter.status')}</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as RedFlagStatus | '');
                setOffset(0);
              }}
            >
              <option value="">{t('gov10.red.filter.all')}</option>
              {RED_FLAG_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {redStatusLabel(t, entry)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('gov10.red.filter.band')}</span>
            <select
              value={band}
              onChange={(event) => {
                setBand(event.target.value as RedFlagBand | '');
                setOffset(0);
              }}
            >
              <option value="">{t('gov10.red.filter.all')}</option>
              {RED_FLAG_BANDS.map((entry) => (
                <option key={entry} value={entry}>
                  {bandLabel(t, entry)}
                </option>
              ))}
            </select>
          </label>
          <Provenance name={t('gov10.red.score.name')} formula={t('gov10.red.score.formula')} source={t('gov10.red.score.source')} asOf={summary.data?.asOf ?? null} version={t('gov10.red.score.version')} unverified owner={t('gov10.red.score.owner')} />
          <Link to="/aud/aud-16" className="mv-alert-link">
            {t('gov10.red.registryLink')}
          </Link>
        </div>
        {stale ? (
          <p className="gov10-notice gov10-notice--warn" role="status" data-testid="red-flag-stale">
            {t('gov10.red.stale')}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void list.refetch()}>
              {t('gov10.retry')}
            </button>
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {items.length === 0 ? (
            <div className="gov10-notice" role="status" data-testid="red-flag-empty" data-kind={filtered && emptyKind === 'none' ? 'filtered' : emptyKind}>
              <p>{filtered && emptyKind === 'none' ? t('gov10.red.empty.filtered') : emptyKind === 'denied' ? t('gov10.red.empty.denied') : emptyKind === 'never' ? t('gov10.red.empty.never') : t('gov10.red.empty.none')}</p>
            </div>
          ) : (
            <>
              <DataTable caption={t('gov10.red.title')} columns={columns} rows={items} rowKey={(row) => row.id} severity={(row) => (row.band === 'HIGH' ? 'URGENT' : row.band === 'MEDIUM' ? 'ACTION' : null)} />
              <Pager offset={offset} size={RED_FLAG_PAGE} hasMore={answer?.hasMore === true} onOffset={setOffset} />
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}
