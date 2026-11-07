import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AuditLine, SectionCard } from '../../ui';
import { AuditFilterBar } from './audit/AuditFilterBar';
import { AuditTable } from './audit/AuditTable';
import { ExportPanel } from './audit/ExportPanel';
import { SealBanner, instantText } from './audit/SealBanner';
import { useAuditEvents } from './audit/hooks';
import { EMPTY_FILTER, EXPORT_AUDIT_PERMISSION, READ_AUDIT_PERMISSION, filterQuery, hasFilter } from './audit/model';
import type { FilterValues } from './audit/model';
import './adm-kit.css';
import './audit/audit.css';

/**
 * ADM-11: the audit trail of the tenant, newest first, within the scope of the reader (ST-ADM-016). A banner above the table
 * carries the kept verdict of the seal verification; the export asks for a sealed slice of at most 366 days.
 */
export default function AuditLogScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_AUDIT_PERMISSION);
  // A suspended tenant (READ_ONLY mode) is read-only for everyone: an export writes a file and an audit row.
  const canExport = (permissions === undefined || permissions.includes(EXPORT_AUDIT_PERMISSION)) && mode !== 'READ_ONLY';
  const [applied, setApplied] = useState<FilterValues>(EMPTY_FILTER);
  const [exporting, setExporting] = useState(false);
  const query = useMemo(() => filterQuery(applied), [applied]);
  const filtered = hasFilter(applied);
  const list = useAuditEvents(query, canRead);
  const events = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.events), [list.data]);
  const seal = list.data?.pages[0]?.seal;
  // A trail with nothing in it is the empty state; a filter that matches nothing is told in the table, so the filters stay in reach.
  const queryState = useScreenState({
    isLoading: list.isLoading,
    error: list.error ?? undefined,
    data: list.data === undefined ? undefined : events,
    isEmpty: () => !filtered && events.length === 0,
  });
  // Without audit_event.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  const usable = state === 'default' || state === 'empty';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="adm-audit">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.audit.page.title')}</h1>
          <p>{t('adm.audit.page.subtitle')}</p>
        </div>
        {usable && canExport ? (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" aria-expanded={exporting} onClick={() => setExporting(true)}>
              {t('adm.audit.export.open.action')}
            </button>
          </div>
        ) : null}
      </div>
      {seal === undefined ? null : <SealBanner seal={seal} />}
      {seal === undefined || seal.checkedAt === null ? null : (
        <AuditLine
          items={[
            { label: t('w2adm.audit.line.checkedAt'), value: instantText(locale, seal.checkedAt) },
            ...(seal.seals === null ? [] : [{ label: t('w2adm.audit.line.seals'), value: String(seal.seals) }]),
          ]}
        />
      )}
      {exporting && canExport ? <ExportPanel onClose={() => setExporting(false)} /> : null}
      {usable || state === 'loading' ? <AuditFilterBar onApply={setApplied} /> : null}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <SectionCard title={t('w2adm.audit.section.title')}>
          {events.length === 0 ? (
            <p className="adm-kit-empty" role="status">
              {t('adm.audit.filtered.empty')}
            </p>
          ) : (
            <AuditTable events={events} />
          )}
          <div className="adm-kit-foot">
            <span>{t('adm.audit.count.text', { count: events.length })}</span>
            {list.hasNextPage ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('adm.audit.more.action')}
              </button>
            ) : null}
          </div>
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('adm.audit.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
