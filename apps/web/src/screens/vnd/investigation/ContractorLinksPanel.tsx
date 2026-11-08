import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { PartialNotice, PolicyInfo, UnverifiedPill } from '../shared/vnd-ui';
import { useContractorLinks } from './investigation-hooks';
import { vietnamStamp } from './investigation-model';
import { LinkGraph } from './LinkGraph';
import './investigation.css';

const hidden = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * The related parties around one contractor (V6), for the auditors: the graph with its table, the clusters the links form, the keys that were ignored because too many contractors share them (an address of a public office is
 * noise, and it is said so), and the rule with its "i". It is exported for the profile screen of the register; a reader who may not see it (not an auditor, or took part in the packages) gets a plain notice that leaks nothing.
 */
export function ContractorLinksPanel({ contractorId }: { contractorId: string }) {
  const { t } = useTranslation();
  const query = useContractorLinks(contractorId);
  const data = query.data;
  return (
    <SectionCard title={t('vnd3.links.section.title')} status={data?.policy.unverified === true ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note" data-testid="links-notice">
        {t('vnd3.links.notice.text')}
      </p>
      {query.isLoading && (
        <p className="vnd-none" role="status" aria-busy="true" data-testid="links-loading">
          {t('states.loading.label')}
        </p>
      )}
      {query.isError && data === undefined && (hidden(query.error) ? <p className="callout" role="alert" data-testid="links-hidden">{t('vnd3.links.hidden.text')}</p> : <PartialNotice text={t('vnd3.links.error.text')} onRetry={() => void query.refetch()} testId="links-error" />)}
      {data !== undefined && (
        <div className="vnd-page">
          <p className="vnd-row" data-testid="links-policy">
            <span>{data.scan_at === null ? t('vnd3.links.neverScanned.text') : t('vnd3.links.scanned.text', { time: vietnamStamp(data.scan_at) })}</span>
            <PolicyInfo name={t('vnd3.links.policy.name')} policy={data.policy} />
          </p>
          {data.links.length === 0 ? (
            <p className="vnd-none" data-testid="links-empty">
              {data.scan_at === null ? t('vnd3.links.emptyNever.text') : t('vnd3.links.empty.text')}
            </p>
          ) : (
            <LinkGraph nodes={data.nodes} links={data.links} focusId={data.focus_id} title={t('vnd3.links.graph.title')} />
          )}
          {data.clusters.length > 0 && (
            <ul className="vnd-list" data-testid="links-clusters">
              {data.clusters.map((cluster) => (
                <li key={cluster.key}>{t('vnd3.links.cluster.item', { count: cluster.members.length, score: cluster.score })}</li>
              ))}
            </ul>
          )}
          {data.ignored.length > 0 && (
            <p className="vnd-note" data-testid="links-ignored">
              <StatusPill tone="neutral">{t('vnd3.links.ignored.badge')}</StatusPill> {t('vnd3.links.ignored.text', { count: data.ignored.length })}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
