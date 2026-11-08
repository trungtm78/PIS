import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard } from '../../../ui';
import { vietnamStamp } from '../shared/vnd-model';
import { Empty, ReceiptNote, StaleNotice, useReceipt } from '../shared/vnd-ui';
import { UploadControl } from './portal2-files';
import { usePortalAttachments } from './portal2-hooks';
import { uploadPurposeLabel } from './portal2-labels';
import { UPLOAD_PURPOSES, sizeText } from './portal2-model';
import type { AttachmentLine, UploadPurpose } from './portal2-model';
import { PortalBoundary, PortalLayout } from './portal-ui';


/** VND-24, the files of the contractor on the portal. A contractor sees and attaches only its own files; every file was judged by its bytes, limited in size by the rule and scanned, and a file that could not be scanned is refused. */
export default function PortalFilesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Files key={scope} route={route} />;
}

function Files({ route }: ScreenProps) {
  const { t } = useTranslation();
  const query = usePortalAttachments();
  const receipt = useReceipt();
  const [purpose, setPurpose] = useState<UploadPurpose>('OTHER');
  const list = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: list === undefined ? query.error : undefined, data: list, isEmpty: () => false });
  const refreshFailed = query.isError && list !== undefined;
  return (
    <PortalLayout route={route} active="VND-24" title={t('po2.files.page.title')} subtitle={t('po2.files.page.subtitle')} asOf={list?.as_of} stale={refreshFailed}>
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <PortalBoundary state={state} onRetry={() => void query.refetch()}>
        {list !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('po2.files.upload.title')}>
              <label>
                {t('po2.files.purpose.label')}
                <select value={purpose} data-testid="upload-purpose" onChange={(event) => setPurpose(UPLOAD_PURPOSES.find((candidate) => candidate === event.target.value) ?? 'OTHER')}>
                  {UPLOAD_PURPOSES.map((value) => (
                    <option key={value} value={value}>
                      {uploadPurposeLabel(t, value)}
                    </option>
                  ))}
                </select>
              </label>
              <UploadControl purpose={purpose} limits={list.limits} onUploaded={() => receipt.show(t('vnd.receipt.done.text', { what: t('po2.files.upload.title'), time: vietnamStamp(new Date().toISOString()) }))} />
            </SectionCard>
            <SectionCard title={t('po2.files.list.title')}>
              {list.items.length === 0 ? (
                <Empty text={t('po2.files.empty.text')} testId="files-empty" />
              ) : (
                <DataTable<AttachmentLine>
                  caption={t('po2.files.list.caption')}
                  rows={list.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-attachment-id': row.id })}
                  columns={[
                    { key: 'title', header: t('po2.files.column.title'), pinned: true, render: (row) => row.title },
                    { key: 'purpose', header: t('po2.files.column.purpose'), render: (row) => uploadPurposeLabel(t, row.purpose) },
                    { key: 'type', header: t('po2.files.column.type'), render: (row) => `${row.mime} · ${sizeText(row.size_bytes)}` },
                    { key: 'sha', header: t('po2.files.column.sha'), render: (row) => <code>{row.sha256.slice(0, 12)}</code> },
                    { key: 'at', header: t('po2.files.column.at'), render: (row) => vietnamStamp(row.uploaded_at) },
                    { key: 'linked', header: t('po2.files.column.linked'), render: (row) => (row.linked_kind === null || row.linked_kind === undefined ? t('po2.files.linked.none') : t('po2.files.linked.kind', { kind: row.linked_kind.toLowerCase() })) },
                  ]}
                />
              )}
            </SectionCard>
          </div>
        )}
      </PortalBoundary>
    </PortalLayout>
  );
}
