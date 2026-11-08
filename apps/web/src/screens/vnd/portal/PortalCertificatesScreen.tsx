import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { gradeLabel, kindLabel, staffRoleLabel } from '../shared/vnd-labels';
import { dayText, vietnamStamp } from '../shared/vnd-model';
import { CertificatePill, Empty, ReceiptNote, StaleNotice, useReceipt, useWriter } from '../shared/vnd-ui';
import { SubmitCertificateDialog } from './portal-dialogs';
import { usePortalQualifications } from './portal-hooks';
import { PORTAL_PERMISSION } from './portal-model';
import type { PortalKeyStaff, PortalQualification } from './portal-model';
import { PortalBoundary, PortalLayout } from './portal-ui';

const NONE = '–';

/** VND-18, the certificates and the key staff of the contractor. A certificate put on file here waits for a second person to check it against the original and meets no requirement until then. */
export default function PortalCertificatesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Certificates key={scope} route={route} />;
}

function VerifiedPill({ verified }: { verified: boolean }) {
  const { t } = useTranslation();
  return verified ? (
    <StatusPill tone="success" icon="✓">
      {t('vnp.certs.verified.yes')}
    </StatusPill>
  ) : (
    <StatusPill tone="warning" icon="○">
      {t('vnp.certs.verified.no')}
    </StatusPill>
  );
}

function Certificates({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = usePortalQualifications();
  const [adding, setAdding] = useState(false);
  const receipt = useReceipt();
  const list = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: list === undefined ? query.error : undefined, data: list, isEmpty: () => false });
  const refreshFailed = query.isError && list !== undefined;
  const canAdd = !writer.readOnly && writer.can(PORTAL_PERMISSION.certificate);
  return (
    <PortalLayout
      route={route}
      active="VND-18"
      title={t('vnp.certs.page.title')}
      subtitle={t('vnp.certs.page.subtitle')}
      asOf={list?.as_of}
      stale={refreshFailed}
      actions={
        canAdd ? (
          <button type="button" className="ui-button ui-button--primary" data-testid="add-certificate" onClick={() => setAdding(true)}>
            {t('vnp.certs.add.action')}
          </button>
        ) : undefined
      }
    >
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <PortalBoundary state={state} onRetry={() => void query.refetch()}>
        {list !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnp.certs.section.certificates.title')}>
              {list.qualifications.length === 0 ? (
                <Empty text={t('vnp.certs.certificates.empty.text')} testId="certificates-empty" />
              ) : (
                <DataTable<PortalQualification>
                  caption={t('vnp.certs.certificates.caption')}
                  rows={list.qualifications}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-qualification-id': row.id })}
                  columns={[
                    {
                      key: 'kind',
                      header: t('vnp.certs.column.kind'),
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{kindLabel(t, row.kind)}</span>
                          <span className="vnd-days">
                            {row.certificate_no}
                            {row.grade !== null && ` · ${gradeLabel(t, row.grade)}`}
                          </span>
                        </span>
                      ),
                    },
                    { key: 'scope', header: t('vnp.certs.column.scope'), render: (row) => (row.scope === null ? NONE : row.scope) },
                    { key: 'issuer', header: t('vnp.certs.column.issuer'), render: (row) => row.issuer },
                    { key: 'dates', header: t('vnp.certs.column.dates'), render: (row) => `${dayText(row.issued_on)} – ${row.expires_on === null ? t('vnp.certs.expires.none') : dayText(row.expires_on)}` },
                    { key: 'state', header: t('vnp.certs.column.state'), render: (row) => <CertificatePill state={row.state} daysLeft={row.days_left} /> },
                    { key: 'verified', header: t('vnp.certs.column.verified'), render: (row) => <VerifiedPill verified={row.verified} /> },
                  ]}
                />
              )}
            </SectionCard>
            <SectionCard title={t('vnp.certs.section.staff.title')}>
              {list.key_staff.length === 0 ? (
                <Empty text={t('vnp.certs.staff.empty.text')} testId="staff-empty" />
              ) : (
                <DataTable<PortalKeyStaff>
                  caption={t('vnp.certs.staff.caption')}
                  rows={list.key_staff}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-staff-id': row.id })}
                  columns={[
                    {
                      key: 'person',
                      header: t('vnp.certs.column.person'),
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.person_name}</span>
                          <span className="vnd-days">{staffRoleLabel(t, row.staff_role)}</span>
                        </span>
                      ),
                    },
                    { key: 'title', header: t('vnp.certs.column.title'), render: (row) => row.qualification_title },
                    { key: 'expires', header: t('vnp.certs.column.expires'), render: (row) => (row.expires_on === null ? t('vnp.certs.expires.none') : dayText(row.expires_on)) },
                    { key: 'state', header: t('vnp.certs.column.state'), render: (row) => <CertificatePill state={row.state} daysLeft={row.days_left} /> },
                    { key: 'verified', header: t('vnp.certs.column.verified'), render: (row) => <VerifiedPill verified={row.verified} /> },
                  ]}
                />
              )}
            </SectionCard>
          </div>
        )}
      </PortalBoundary>
      {adding && (
        <SubmitCertificateDialog
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            receipt.show(t('vnd.receipt.done.text', { what: t('vnp.certificate.add.title'), time: vietnamStamp(new Date().toISOString()) }));
          }}
        />
      )}
    </PortalLayout>
  );
}
