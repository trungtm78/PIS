import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { errorText } from '../shared/vnd-labels';
import { PATHS, isUuid } from '../shared/vnd-model';
import { CountInfo, Empty, PolicyInfo, ReceiptNote, Screen, ScreenFooter, ScreenHead, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { useDisputes, useOcdsExport } from './investigation-hooks';
import { disputeKindLabel, disputeOutcomeLabel } from './investigation-labels';
import { INV_PERMISSION, dayText, numberText, ocdsFileName, ocdsFileText, percentText, vietnamStamp } from './investigation-model';
import type { DisputeLine, DisputeStats, Disputes } from './investigation-model';
import './investigation.css';

/** Hands a text to the person as a file: a blob, a link that is clicked once and the address given back. Nothing leaves the browser. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const outcomeTone = (outcome: DisputeLine['outcome']): 'info' | 'success' | 'neutral' | 'warning' => (outcome === 'OPEN' ? 'info' : outcome === 'UPHELD' ? 'warning' : outcome === 'REJECTED' ? 'success' : 'neutral');

/**
 * VND-22, the disputes of contractors (V16) and the export of parties (V18). The petitions of the bidders and the claims of the contractors are counted for one contractor and for the whole register: how many, how many are
 * still open, the share upheld among the decided ones and the mean days to close; a share is said as none while nothing was decided, never as zero. The export hands the parties of the register in the shape of the Open
 * Contracting Data Standard with the tax code as identifier; the beneficial owners and the contact point are left out unless the rule of the tenant allows them (off by default: the legal basis is not confirmed).
 */
export default function DisputesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contractor = useIdParam('contractor');
  return <DisputesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${contractor ?? ''}`} route={route} contractor={contractor !== undefined && isUuid(contractor) ? contractor : undefined} />;
}

function DisputesContent({ route, contractor }: ScreenProps & { contractor: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = useDisputes(contractor);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd3.disputes.page.title')} subtitle={t('vnd3.disputes.page.subtitle')} asOf={data?.as_of} stale={query.isError && data !== undefined} />
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <div className="vnd-cols" data-testid="dispute-cards">
              {contractor !== undefined && <StatsCard kind="contractor" title={t('vnd3.disputes.card.contractor.title')} stats={data.stats} asOf={data.as_of} />}
              <StatsCard kind="petitions" title={t('vnd3.disputes.card.petitions.title')} stats={data.petitions} asOf={data.as_of} />
              <StatsCard kind="claims" title={t('vnd3.disputes.card.claims.title')} stats={data.claims} asOf={data.as_of} />
              <StatsCard kind="portfolio" title={t('vnd3.disputes.card.portfolio.title')} stats={data.portfolio} asOf={data.as_of} />
            </div>
            <ItemsSection data={data} contractor={contractor} />
            {writer.can(INV_PERMISSION.ocdsExport) && <OcdsPanel contractor={contractor} />}
          </div>
        )}
      </StateBoundary>
      <ScreenFooter route={route} />
    </Screen>
  );
}

function StatsCard({ kind, title, stats, asOf }: { kind: string; title: string; stats: DisputeStats; asOf: string }) {
  const { t, locale } = useTranslation();
  return (
    <SectionCard title={title}>
      <dl className="vnd-facts" data-testid={`dispute-card-${kind}`}>
        <div className="vnd-fact">
          <dt>{t('vnd3.disputes.fact.total.label')}</dt>
          <dd data-testid={`${kind}-total`}>{numberText(stats.total, locale)}</dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd3.disputes.fact.open.label')}</dt>
          <dd data-testid={`${kind}-open`}>{numberText(stats.open, locale)}</dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd3.disputes.fact.decided.label')}</dt>
          <dd data-testid={`${kind}-decided`}>{t('vnd3.disputes.fact.decided.text', { upheld: stats.upheld, rejected: stats.rejected, withdrawn: stats.withdrawn })}</dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd3.disputes.fact.upheld.label')}</dt>
          <dd className="vnd-row">
            <strong data-testid={`${kind}-upheld-pct`}>{percentText(stats.upheld_pct, locale)}</strong>
            <CountInfo name={t('vnd3.disputes.fact.upheld.label')} formula={t('vnd3.disputes.fact.upheld.formula')} source={t('vnd3.disputes.fact.source')} asOf={asOf} />
          </dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd3.disputes.fact.days.label')}</dt>
          <dd className="vnd-row">
            <strong data-testid={`${kind}-days`}>{stats.mean_days_to_close === null ? '–' : t('vnd3.disputes.fact.days.text', { days: numberText(stats.mean_days_to_close, locale) })}</strong>
            <CountInfo name={t('vnd3.disputes.fact.days.label')} formula={t('vnd3.disputes.fact.days.formula')} source={t('vnd3.disputes.fact.source')} asOf={asOf} />
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}

function ItemsSection({ data, contractor }: { data: Disputes; contractor: string | undefined }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd3.disputes.section.items.title')}>
      {contractor !== undefined && (
        <p className="vnd-note">
          <Link to={PATHS.profile(contractor)}>{t('vnd3.disputes.profile.link')}</Link>
        </p>
      )}
      <DataTable<DisputeLine>
        caption={t('vnd3.disputes.table.caption')}
        rows={data.items}
        rowKey={(row) => `${row.kind}:${row.id}`}
        rowAttrs={(row) => ({ 'data-dispute-id': row.id })}
        state={data.items.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'kind', header: t('vnd3.disputes.column.kind'), pinned: true, render: (row) => disputeKindLabel(t, row.kind) },
          { key: 'contractor', header: t('vnd3.disputes.column.contractor'), render: (row) => <Link to={PATHS.profile(row.contractor_id)}>{row.contractor_name}</Link> },
          { key: 'subject', header: t('vnd3.disputes.column.subject'), render: (row) => row.subject_code ?? '–' },
          {
            key: 'outcome',
            header: t('vnd3.disputes.column.outcome'),
            render: (row) => (
              <span className="vnd-stack">
                <StatusPill tone={outcomeTone(row.outcome)}>{disputeOutcomeLabel(t, row.outcome)}</StatusPill>
                <span className="vnd-days">{row.source_status}</span>
              </span>
            ),
          },
          { key: 'opened', header: t('vnd3.disputes.column.opened'), render: (row) => dayText(row.opened_on) },
          { key: 'closed', header: t('vnd3.disputes.column.closed'), render: (row) => (row.closed_on === null ? '–' : dayText(row.closed_on)) },
        ]}
      />
    </SectionCard>
  );
}

function OcdsPanel({ contractor }: { contractor: string | undefined }) {
  const { t } = useTranslation();
  const exporter = useOcdsExport();
  const receipt = useReceipt();
  const [packageId, setPackageId] = useState('');
  const [failure, setFailure] = useState<unknown>(undefined);
  const [last, setLast] = useState<{ owners: boolean; contact: boolean; parties: number } | undefined>(undefined);
  const badPackage = packageId.trim() !== '' && !isUuid(packageId);

  const run = (): void => {
    setFailure(undefined);
    exporter.mutateAsync({ contractor, packageId: packageId.trim() === '' ? undefined : packageId.trim() }).then(
      (answer) => {
        downloadText(ocdsFileName(answer.as_of), ocdsFileText(answer));
        setLast({ owners: answer.owners_included, contact: answer.contact_included, parties: answer.parties.length });
        receipt.show(t('vnd3.ocds.receipt.text', { count: answer.parties.length, time: vietnamStamp(new Date().toISOString()) }));
      },
      (error: unknown) => setFailure(error),
    );
  };

  return (
    <SectionCard title={t('vnd3.ocds.section.title')} status={exporter.data?.policy.unverified === true ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note" data-testid="ocds-notice">
        {t('vnd3.ocds.notice.text')}
      </p>
      <ReceiptNote text={receipt.receipt} />
      <div className="vnd-filters">
        <label>
          {t('vnd3.ocds.field.package.label')}
          <input type="text" value={packageId} aria-invalid={badPackage} onChange={(event) => setPackageId(event.target.value)} />
        </label>
        <span className="vnd-row">
          <button type="button" className="ui-button ui-button--primary" data-testid="download-ocds" disabled={exporter.isPending || badPackage} onClick={run}>
            {exporter.isPending ? t('vnd3.ocds.download.pending') : t('vnd3.ocds.download.action')}
          </button>
        </span>
      </div>
      {failure !== undefined && (
        <p className="callout" role="alert" data-testid="ocds-error">
          {errorText(t, failure)}
        </p>
      )}
      {last === undefined ? (
        <Empty text={t('vnd3.ocds.none.text')} testId="ocds-none" />
      ) : (
        <p className="vnd-row" data-testid="ocds-result">
          <span>{t('vnd3.ocds.result.text', { count: last.parties, owners: last.owners ? t('vnd3.ocds.flag.included') : t('vnd3.ocds.flag.excluded'), contact: last.contact ? t('vnd3.ocds.flag.included') : t('vnd3.ocds.flag.excluded') })}</span>
          {exporter.data !== undefined && <PolicyInfo name={t('vnd3.ocds.policy.name')} policy={exporter.data.policy} />}
        </p>
      )}
    </SectionCard>
  );
}
