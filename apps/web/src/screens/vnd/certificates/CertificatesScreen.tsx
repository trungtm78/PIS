import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { useExpiries, usePackageRequirements, useProfile } from '../shared/vnd-hooks';
import { certificateStateLabel, gapLabel, gradeLabel, kindLabel, staffRoleLabel, subjectLabel } from '../shared/vnd-labels';
import { CERTIFICATE_STATES, PERMISSION, PATHS, dayText, daysBetween, failureStatus, isUuid, requirementFindings, vietnamDay, vietnamStamp } from '../shared/vnd-model';
import type { CertificateState, ExpiryItem, KeyStaff, Policy, ProfileView, Qualification, Requirement } from '../shared/vnd-model';
import { CertificatePill, CountInfo, Empty, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { AddKeyStaffDialog, AddQualificationDialog, RequirementsDialog, RevokeDialog, VerifyDialog } from './certificate-dialogs';
import type { CertificateSubject } from './certificate-dialogs';

const NONE = '–';

/**
 * VND-05, the certificates and the key staff of contractors. With a contractor in the address it is that contractor's certificates and staff, with the check against the original (another person than the one who entered), the
 * requirements of a package and where the certificates fall short of them. Without one it is the watch over every contractor: what is running out and what has run out. A certificate nobody checked meets no requirement.
 */
export default function CertificatesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contractor = useIdParam('contractor', 'id');
  const packageId = useIdParam('package');
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  if (contractor !== undefined) return <ContractorCertificates key={`${scope}:${contractor}`} route={route} id={contractor} packageId={packageId} />;
  return <ExpiryWatch key={scope} route={route} packageId={packageId} />;
}

type Dialog =
  | { kind: 'qualification' }
  | { kind: 'staff' }
  | { kind: 'verify'; target: CertificateSubject }
  | { kind: 'revoke'; target: CertificateSubject }
  | { kind: 'requirements'; packageId: string; current: readonly Requirement[] };

function ContractorCertificates({ route, id, packageId }: ScreenProps & { id: string; packageId: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = useProfile(id);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const view = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: view === undefined ? query.error : undefined, data: view, isEmpty: () => false });
  const state: ScreenState = view === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && view !== undefined;
  const canManage = !writer.readOnly && view?.actions.manage_certificates === true;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.certs.page.title')}
        subtitle={view === undefined ? t('vnd.certs.page.subtitle') : t('vnd.certs.page.contractor.text', { name: view.profile.legal_name })}
        asOf={view?.as_of}
        stale={refreshFailed}
        actions={
          <>
            <Link className="ui-button ui-button--outline" to={PATHS.certificates()}>
              {t('vnd.certs.watch.link')}
            </Link>
            {canManage && (
              <>
                <button type="button" className="ui-button ui-button--outline" data-testid="add-staff" onClick={() => setDialog({ kind: 'staff' })}>
                  {t('vnd.certs.staff.add.action')}
                </button>
                <button type="button" className="ui-button ui-button--primary" data-testid="add-qualification" onClick={() => setDialog({ kind: 'qualification' })}>
                  {t('vnd.certs.add.action')}
                </button>
              </>
            )}
          </>
        }
        {...(view === undefined ? {} : { items: [{ label: t('vnd.certs.context.contractor'), value: view.profile.legal_name }] })}
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {view !== undefined && (
          <div className="vnd-page">
            <QualificationsCard view={view} canVerify={!writer.readOnly} canManage={canManage} onVerify={(target) => setDialog({ kind: 'verify', target })} onRevoke={(target) => setDialog({ kind: 'revoke', target })} />
            <StaffCard view={view} canVerify={!writer.readOnly} canManage={canManage} onVerify={(target) => setDialog({ kind: 'verify', target })} onRevoke={(target) => setDialog({ kind: 'revoke', target })} />
            <RequirementsCard packageId={packageId} qualifications={view.qualifications} canSet={!writer.readOnly && writer.can(PERMISSION.qualificationWrite)} onSet={(pid, current) => setDialog({ kind: 'requirements', packageId: pid, current })} asOf={view.as_of} policy={view.policies.qualification_expiry} />
          </div>
        )}
      </StateBoundary>
      {view !== undefined && dialog?.kind === 'qualification' && <AddQualificationDialog view={view} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.certs.add.title'))} />}
      {view !== undefined && dialog?.kind === 'staff' && <AddKeyStaffDialog view={view} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.certs.staff.add.title'))} />}
      {dialog?.kind === 'verify' && <VerifyDialog target={dialog.target} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.certs.verify.title'))} />}
      {dialog?.kind === 'revoke' && <RevokeDialog target={dialog.target} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.certs.revoke.title'))} />}
      {dialog?.kind === 'requirements' && <RequirementsDialog packageId={dialog.packageId} current={dialog.current} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.certs.requirements.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

/** Who checked a certificate and when; one nobody checked says so plainly (it meets no requirement). */
function VerifiedCell({ by, at }: { by: string | null; at: string | null }) {
  const { t } = useTranslation();
  if (at === null) {
    return (
      <StatusPill tone="warning" icon="○">
        {t('vnd.certs.verified.no')}
      </StatusPill>
    );
  }
  return (
    <span className="vnd-stack">
      <StatusPill tone="success" icon="✓">
        {t('vnd.certs.verified.yes')}
      </StatusPill>
      <span className="vnd-days">{t('vnd.certs.verified.by.text', { name: by ?? NONE, time: vietnamStamp(at) })}</span>
    </span>
  );
}

interface CardProps {
  view: ProfileView;
  canVerify: boolean;
  canManage: boolean;
  onVerify: (target: CertificateSubject) => void;
  onRevoke: (target: CertificateSubject) => void;
}

function QualificationsCard({ view, canVerify, canManage, onVerify, onRevoke }: CardProps) {
  const { t } = useTranslation();
  const policy = view.policies.qualification_expiry;
  return (
    <SectionCard title={t('vnd.certs.section.qualifications.title')} status={policy.unverified ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note vnd-row">
        <span>{t('vnd.certs.expiry.rule.text')}</span>
        <PolicyInfo name={t('vnd.certs.figure.expiry.name')} policy={policy} />
      </p>
      {view.qualifications.length === 0 ? (
        <Empty text={t('vnd.certs.qualifications.empty.text')} testId="qualifications-empty" />
      ) : (
        <DataTable<Qualification>
          caption={t('vnd.certs.qualifications.caption')}
          rows={view.qualifications}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-qualification-id': row.id })}
          columns={[
            {
              key: 'kind',
              header: t('vnd.certs.column.kind'),
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
            { key: 'scope', header: t('vnd.certs.column.scope'), render: (row) => (row.scope === null ? NONE : row.scope) },
            { key: 'issuer', header: t('vnd.certs.column.issuer'), render: (row) => row.issuer },
            { key: 'dates', header: t('vnd.certs.column.dates'), render: (row) => `${dayText(row.issued_on)} – ${row.expires_on === null ? t('vnd.certs.expires.none') : dayText(row.expires_on)}` },
            { key: 'state', header: t('vnd.certs.column.state'), render: (row) => <CertificatePill state={row.state} daysLeft={row.days_left} /> },
            { key: 'verified', header: t('vnd.certs.column.verified'), render: (row) => <VerifiedCell by={row.verified_by_name} at={row.verified_at} /> },
            {
              key: 'actions',
              header: t('vnd.certs.column.actions'),
              render: (row) => (
                <span className="vnd-row">
                  {canVerify && row.may_verify && row.verified_at === null && row.state !== 'REVOKED' && (
                    <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="verify" onClick={() => onVerify({ subject: 'qualification', item: row })}>
                      {t('vnd.certs.verify.action')}
                    </button>
                  )}
                  {canManage && row.state !== 'REVOKED' && (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="revoke" onClick={() => onRevoke({ subject: 'qualification', item: row })}>
                      {t('vnd.certs.revoke.action')}
                    </button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

function StaffCard({ view, canVerify, canManage, onVerify, onRevoke }: CardProps) {
  const { t } = useTranslation();
  const policy = view.policies.key_staff_expiry;
  return (
    <SectionCard title={t('vnd.certs.section.staff.title')} status={policy.unverified ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note vnd-row">
        <span>{t('vnd.certs.expiry.rule.text')}</span>
        <PolicyInfo name={t('vnd.certs.figure.expiry.name')} policy={policy} />
      </p>
      {view.key_staff.length === 0 ? (
        <Empty text={t('vnd.certs.staff.empty.text')} testId="staff-empty" />
      ) : (
        <DataTable<KeyStaff>
          caption={t('vnd.certs.staff.caption')}
          rows={view.key_staff}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-staff-id': row.id })}
          columns={[
            {
              key: 'person',
              header: t('vnd.certs.staff.column.person'),
              pinned: true,
              render: (row) => (
                <span className="vnd-stack">
                  <span>{row.person_name}</span>
                  <span className="vnd-days">{staffRoleLabel(t, row.staff_role)}</span>
                </span>
              ),
            },
            { key: 'title', header: t('vnd.certs.staff.column.title'), render: (row) => `${row.qualification_title}${row.certificate_no === null ? '' : ` · ${row.certificate_no}`}` },
            { key: 'dates', header: t('vnd.certs.column.dates'), render: (row) => `${dayText(row.issued_on)} – ${row.expires_on === null ? t('vnd.certs.expires.none') : dayText(row.expires_on)}` },
            { key: 'state', header: t('vnd.certs.column.state'), render: (row) => <CertificatePill state={row.state} daysLeft={row.days_left} /> },
            { key: 'verified', header: t('vnd.certs.column.verified'), render: (row) => <VerifiedCell by={row.verified_by_name} at={row.verified_at} /> },
            {
              key: 'actions',
              header: t('vnd.certs.column.actions'),
              render: (row) => (
                <span className="vnd-row">
                  {canVerify && row.may_verify && row.verified_at === null && row.state !== 'REVOKED' && (
                    <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="verify-staff" onClick={() => onVerify({ subject: 'key-staff', item: row })}>
                      {t('vnd.certs.verify.action')}
                    </button>
                  )}
                  {canManage && row.state !== 'REVOKED' && (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="revoke-staff" onClick={() => onRevoke({ subject: 'key-staff', item: row })}>
                      {t('vnd.certs.revoke.action')}
                    </button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- the requirements of a package -----------------------------------------------------------------------------------------------------------------------------------

/**
 * The requirements of one package (chosen by its id) and, for the contractor on the screen, where its certificates fall short: a missing kind, a certificate nobody checked, one that ran out or was revoked, a grade too low, a scope that
 * does not name the word. The gaps are a preview worked out here from the certificates shown above; the check at the evaluation of the bids is the server's.
 */
export function RequirementsCard({ packageId, qualifications, canSet, onSet, asOf, policy }: { packageId: string | undefined; qualifications: readonly Qualification[] | undefined; canSet: boolean; onSet: (packageId: string, current: readonly Requirement[]) => void; asOf: string; policy: Policy | undefined }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(packageId ?? '');
  const [chosen, setChosen] = useState<string | undefined>(packageId !== undefined && isUuid(packageId) ? packageId : undefined);
  const query = usePackageRequirements(chosen);
  const data = query.data;
  const invalid = draft.trim() !== '' && !isUuid(draft);
  const findings = data === undefined || qualifications === undefined ? undefined : requirementFindings(data.requirements, qualifications);
  const load = (event: FormEvent): void => {
    event.preventDefault();
    if (isUuid(draft)) setChosen(draft.trim());
  };
  return (
    <SectionCard title={t('vnd.certs.section.requirements.title')} status={policy?.unverified === true ? <UnverifiedPill /> : undefined}>
      <form className="vnd-inline-form" onSubmit={load} aria-label={t('vnd.certs.requirements.form.label')}>
        <div className="vnd-field">
          <label htmlFor="requirements-package">{t('vnd.certs.requirements.package.label')}</label>
          <input id="requirements-package" type="text" autoComplete="off" value={draft} aria-invalid={invalid ? true : undefined} onChange={(event) => setDraft(event.target.value)} />
          {invalid && <span className="vnd-field__error">{t('vnd.field.uuid.text')}</span>}
        </div>
        <div>
          <button type="submit" className="ui-button ui-button--primary" data-testid="load-requirements" disabled={!isUuid(draft)}>
            {t('vnd.certs.requirements.load.action')}
          </button>
        </div>
      </form>
      {chosen === undefined && <Empty text={t('vnd.certs.requirements.choose.text')} testId="requirements-choose" />}
      {chosen !== undefined && query.isLoading && (
        <p className="vnd-none" role="status" aria-busy="true" data-testid="requirements-loading">
          {t('states.loading.label')}
        </p>
      )}
      {chosen !== undefined && query.isError && (
        <p className="callout" role="alert" data-testid="requirements-error">
          {t('vnd.certs.requirements.error.text')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
            {t('states.retry.action')}
          </button>
        </p>
      )}
      {data !== undefined && (
        <>
          <p className="vnd-row">
            <CountInfo name={t('vnd.certs.figure.gaps.name')} formula={t('vnd.certs.figure.gaps.formula')} source={t('vnd.certs.figure.gaps.source')} asOf={asOf} />
            {canSet && (
              <button type="button" className="ui-button ui-button--outline" data-testid="set-requirements" onClick={() => onSet(data.package_id, data.requirements)}>
                {t('vnd.certs.requirements.set.action')}
              </button>
            )}
            {findings === undefined && <span className="vnd-note">{t('vnd.certs.requirements.noContractor.text')}</span>}
          </p>
          {data.requirements.length === 0 ? (
            <Empty text={t('vnd.certs.requirements.empty.text')} testId="requirements-empty" />
          ) : (
            <DataTable<Requirement>
              caption={t('vnd.certs.requirements.caption')}
              rows={[...data.requirements]}
              rowKey={(row) => `${row.kind}:${row.min_grade ?? ''}:${row.scope_keyword ?? ''}`}
              rowAttrs={(row) => ({ 'data-kind': row.kind })}
              columns={[
                { key: 'kind', header: t('vnd.certs.requirements.column.kind'), pinned: true, render: (row) => kindLabel(t, row.kind) },
                { key: 'grade', header: t('vnd.certs.requirements.column.grade'), render: (row) => (row.min_grade === null ? NONE : gradeLabel(t, row.min_grade)) },
                { key: 'keyword', header: t('vnd.certs.requirements.column.keyword'), render: (row) => row.scope_keyword ?? NONE },
                ...(findings === undefined
                  ? []
                  : [
                      {
                        key: 'gap',
                        header: t('vnd.certs.requirements.column.gap'),
                        render: (row: Requirement) => {
                          const found = findings[data.requirements.indexOf(row)];
                          return found === undefined || found.gap === null ? (
                            <StatusPill tone="success" icon="✓">
                              {t('vnd.certs.requirements.met.text')}
                            </StatusPill>
                          ) : (
                            <StatusPill tone="danger" icon="⛔">
                              {gapLabel(t, found.gap)}
                            </StatusPill>
                          );
                        },
                      },
                    ]),
              ]}
            />
          )}
        </>
      )}
    </SectionCard>
  );
}

// ---- the watch over every contractor ---------------------------------------------------------------------------------------------------------------------------------

function ExpiryWatch({ route, packageId }: ScreenProps & { packageId: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = useExpiries();
  const [stateFilter, setStateFilter] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const rows = data === undefined ? [] : data.items.filter((item) => stateFilter === '' || item.state === stateFilter);
  const today = data === undefined ? '' : vietnamDay(data.as_of);
  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.certs.page.title')} subtitle={t('vnd.certs.watch.subtitle')} asOf={data?.as_of} stale={refreshFailed} />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <SectionCard title={t('vnd.certs.watch.filter.title')}>
        <div className="vnd-filters">
          <label>
            {t('vnd.certs.watch.state.label')}
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
              <option value="">{t('vnd.register.filter.any.option')}</option>
              {CERTIFICATE_STATES.filter((item) => item === 'EXPIRING_FIRST' || item === 'EXPIRING_SECOND' || item === 'EXPIRED').map((item: CertificateState) => (
                <option key={item} value={item}>
                  {certificateStateLabel(t, item)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SectionCard>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnd.certs.watch.section.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row">
                <span>{t('vnd.certs.expiry.rule.text')}</span>
                <PolicyInfo name={t('vnd.certs.figure.expiry.name')} policy={data.policy} />
              </p>
              <DataTable<ExpiryItem>
                caption={t('vnd.certs.watch.caption')}
                rows={rows}
                rowKey={(row) => `${row.subject}:${row.id}`}
                rowAttrs={(row) => ({ 'data-expiry-id': row.id })}
                state={rows.length === 0 ? 'empty' : 'ready'}
                emptyKind={stateFilter === '' ? 'none' : 'filtered'}
                onClearFilters={() => setStateFilter('')}
                severity={(row) => (row.state === 'EXPIRED' ? 'URGENT' : row.state === 'EXPIRING_SECOND' ? 'ACTION' : null)}
                columns={[
                  { key: 'contractor', header: t('vnd.certs.watch.column.contractor'), pinned: true, render: (row) => <Link to={PATHS.certificates(row.contractor_id)}>{row.contractor_name}</Link> },
                  { key: 'subject', header: t('vnd.certs.watch.column.subject'), render: (row) => subjectLabel(t, row.subject) },
                  { key: 'label', header: t('vnd.certs.watch.column.label'), render: (row) => row.label },
                  { key: 'expires', header: t('vnd.certs.watch.column.expires'), render: (row) => dayText(row.expires_on) },
                  { key: 'state', header: t('vnd.certs.column.state'), render: (row) => <CertificatePill state={row.state} daysLeft={daysBetween(today, row.expires_on)} /> },
                ]}
              />
            </SectionCard>
            <RequirementsCard packageId={packageId} qualifications={undefined} canSet={!writer.readOnly && writer.can(PERMISSION.qualificationWrite)} onSet={(pid, current) => setDialog({ kind: 'requirements', packageId: pid, current })} asOf={data.as_of} policy={data.policy} />
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'requirements' && (
        <RequirementsDialog
          packageId={dialog.packageId}
          current={dialog.current}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            receipt.show(t('vnd.receipt.done.text', { what: t('vnd.certs.requirements.title'), time: vietnamStamp(new Date().toISOString()) }));
          }}
        />
      )}
      <ScreenFooter route={route} />
    </Screen>
  );
}
