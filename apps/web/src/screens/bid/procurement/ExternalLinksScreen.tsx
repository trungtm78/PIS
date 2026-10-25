import { useMemo, useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useWholeTenantAuthority } from '../../prj/national-code-import-hooks';
import { useExternalLinks } from './hooks';
import { diffStatusLabel, milestoneLabel } from './labels';
import { DIFF_STATUSES, IMPORT_PERMISSION, canImport, filterLinks, shortHash, vietnamDay } from './model';
import type { LinkLine, StatusFilter } from './model';
import { ProcurementImportPanel } from './ProcurementImportPanel';
import '../bid.css';

/**
 * BID-19: the link between the packages and their codes on the national bidding network, and the reconciliation (ST-BID-005): the file downloaded from the national system is
 * read without writing anything, then applied once; the register keeps what it holds and a disagreement (another date for a milestone, another code for the package) is
 * shown with its owner until a person settles it. The adapter is a proposal: only a file is read, no call is made to the national system.
 */
export default function ExternalLinksScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The links and the panel belong to one membership: a switch of tenant or of membership starts the screen over.
  return <LinksContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LinksContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const links = useExternalLinks();
  const [status, setStatus] = useState<StatusFilter>('');
  const mayImport = canImport(permissions, mode);
  const wholeTenant = useWholeTenantAuthority(IMPORT_PERMISSION, mayImport);
  // A tenant without a link yet is not an empty screen: the planner still needs the panel that reads the first file.
  const state = useScreenState({ isLoading: links.isLoading, error: links.error, data: links.data, isEmpty: () => false });
  const shown = useMemo(() => filterLinks(links.data ?? [], status), [links.data, status]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.links.page.title')}</h1>
          <p>{t('bid.links.page.subtitle')}</p>
        </div>
      </div>
      <ProcurementImportPanel canImport={mayImport} wholeTenant={wholeTenant} />
      <StateBoundary state={state} onRetry={() => void links.refetch()}>
        <div className="card">
          <div className="field">
            <label htmlFor="links-status">{t('bid.links.status.label')}</label>
            <select id="links-status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
              <option value="">{t('bid.links.status.all')}</option>
              {DIFF_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {diffStatusLabel(t, value)}
                </option>
              ))}
            </select>
          </div>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-links">
              {(links.data ?? []).length === 0 ? t('bid.links.empty.notice') : t('bid.links.noMatch.notice')}
            </p>
          ) : (
            <table className="table" data-testid="links">
              <thead>
                <tr>
                  <th scope="col">{t('bid.links.column.package')}</th>
                  <th scope="col">{t('bid.links.column.external')}</th>
                  <th scope="col">{t('bid.links.column.source')}</th>
                  <th scope="col">{t('bid.links.column.synced')}</th>
                  <th scope="col">{t('bid.links.column.difference')}</th>
                  <th scope="col">{t('bid.links.column.hash')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((link) => (
                  <LinkRow key={link.id} link={link} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('bid.links.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function LinkRow({ link }: { link: LinkLine }) {
  const { t } = useTranslation();
  return (
    <tr data-link-id={link.id} data-diff-status={link.diffStatus}>
      <th scope="row">{link.packageTitle === null ? link.packageCode : `${link.packageCode} · ${link.packageTitle}`}</th>
      <td>{link.externalCode}</td>
      <td data-testid="source">
        <span className="bid-badge" data-testid="adapter">
          {link.adapterStatus === null ? t('bid.links.source.none') : t('bid.links.source.file', { status: link.adapterStatus })}
        </span>
      </td>
      <td data-testid="synced">{link.appliedAt === null ? t('bid.links.synced.none') : vietnamDay(link.appliedAt)}</td>
      <td data-testid="difference">
        <span className={link.diffStatus === 'IN_SYNC' ? 'bid-badge ok' : 'bid-badge warning'} data-testid="diff-status">
          {diffStatusLabel(t, link.diffStatus)}
        </span>
        {link.codeDifference === null ? null : (
          <small className="sub" data-testid="code-difference">
            {t('bid.links.difference.code', { register: link.codeDifference.register, file: link.codeDifference.file })}
          </small>
        )}
        {link.milestoneDifferences.map((difference) => (
          <small key={difference.kind} className="sub" data-testid="milestone-difference" data-kind={difference.kind}>
            {t('bid.links.difference.milestone', { kind: milestoneLabel(t, difference.kind), register: vietnamDay(difference.register), file: vietnamDay(difference.file) })}
          </small>
        ))}
        {link.diffStatus === 'IN_SYNC' || link.ownerName === null ? null : (
          <small className="sub" data-testid="owner">
            {t('bid.links.difference.owner', { name: link.ownerName })}
          </small>
        )}
      </td>
      <td data-testid="hash">{link.fileSha256 === null ? '' : shortHash(link.fileSha256)}</td>
    </tr>
  );
}
