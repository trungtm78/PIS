import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { HashLine } from '../../rpt/components';
import { useCatalogue, useIssues } from '../../rpt/hooks';
import { kindWord, statusWord, vietnamDateTime } from '../../rpt/model';
import type { Entry, Issue } from '../../rpt/model';
import { LockPill, RuleInfo, SignaturePill } from './rptGov12Components';
import { useCertificates, useCompleteSignature, useLocks, useSignature, useStartSignature } from './rptGov12Hooks';
import { holds, isMofForm, isPending, signRefusalText, signatureState } from './rptGov12Model';
import './rptGov12.css';

/** How often the completion of a signature is asked for while the signer approves on their device. */
const POLL_MS = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function SignDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const certificates = useCertificates(true);
  const start = useStartSignature();
  const complete = useCompleteSignature();
  const [certificateId, setCertificateId] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const busy = useRef(false);
  // Only the active personal certificates of the signer are offered; when the list cannot be read the person types the id.
  const own = (certificates.data?.items ?? []).filter((one) => one.kind === 'PERSONAL' && one.status === 'Active' && (tenant?.membershipId === undefined || one.holder_membership_id === tenant.membershipId));
  const listed = certificates.data !== undefined && !certificates.isError;

  const finish = (): void => {
    if (sessionId === undefined || busy.current) return;
    busy.current = true;
    complete.mutate(
      { sessionId },
      {
        onSuccess: (result) => {
          busy.current = false;
          if (isPending(result.status)) {
            setWaiting(true);
            return;
          }
          onClose();
        },
        onError: (failure) => {
          busy.current = false;
          setWaiting(false);
          setSessionId(undefined);
          setError(signRefusalText(t, failure));
        },
      },
    );
  };

  // The poll holds the latest `finish` and restarts only when the session changes.
  const latest = useRef(finish);
  useEffect(() => {
    latest.current = finish;
  });
  useEffect(() => {
    if (sessionId === undefined) return undefined;
    const timer = setInterval(() => latest.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId]);

  const begin = (): void => {
    if (!UUID.test(certificateId)) {
      setError(t('rpt.mof.sign.certificate.invalid'));
      return;
    }
    start.mutate(
      { issueId: issue.id, certificateId },
      {
        onSuccess: (result) => {
          setError(undefined);
          setSessionId(result.resource_id);
        },
        onError: (failure) => setError(signRefusalText(t, failure)),
      },
    );
  };

  return (
    <ConfirmDialog
      open
      title={t('rpt.mof.sign.title', { code: issue.layout_code, period: issue.period_code, revision: issue.revision })}
      context={[
        { label: t('rpt.mof.sign.digest'), value: issue.sha256.slice(0, 16) },
        { label: t('rpt.mof.sign.provider'), value: t('rpt.mof.sign.provider.text') },
      ]}
      confirmLabel={sessionId === undefined ? t('rpt.mof.sign.start') : t('rpt.mof.sign.complete')}
      cancelLabel={t('rpt.mof.sign.cancel')}
      pending={start.isPending || complete.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => (sessionId === undefined ? begin() : finish())}
    >
      <div className="rpt-g12-sign" data-testid="sign-fields">
        {sessionId === undefined ? (
          listed ? (
            <label>
              {t('rpt.mof.sign.certificate')}
              <select value={certificateId} data-testid="sign-certificate" onChange={(event) => { setError(undefined); setCertificateId(event.target.value); }}>
                <option value="">{t('rpt.mof.sign.certificate.choose')}</option>
                {own.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.subject_dn}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {t('rpt.mof.sign.certificate.id')}
              <input type="text" maxLength={36} value={certificateId} data-testid="sign-certificate-id" onChange={(event) => { setError(undefined); setCertificateId(event.target.value.trim()); }} />
            </label>
          )
        ) : (
          <p className="callout" role="status" data-testid="sign-waiting">
            {waiting ? t('rpt.mof.sign.waiting') : t('rpt.mof.sign.started')}
          </p>
        )}
        {listed && own.length === 0 && sessionId === undefined ? <p className="callout warning" role="status" data-testid="sign-no-certificate">{t('rpt.mof.sign.certificate.none')}</p> : null}
      </div>
    </ConfirmDialog>
  );
}

function CopyRow({ issue, canSign, onSign }: { issue: Issue; canSign: boolean; onSign: (issue: Issue) => void }) {
  const { t } = useTranslation();
  const query = useSignature(issue.id);
  const facts = query.data;
  const state = signatureState(facts);
  return (
    <div data-testid={`copy-${issue.id}`}>
      <SignaturePill facts={facts} />
      {state === 'test' ? <p className="rpt-g12-pending" data-testid={`test-note-${issue.id}`}>{t('rpt.mof.signature.testNote')}</p> : null}
      {query.isError ? <p className="rpt-g12-pending" role="status">{t('rpt.mof.signature.unknown')}</p> : null}
      {state === 'unsigned' && canSign && facts !== undefined ? (
        <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid={`sign-${issue.id}`} onClick={() => onSign(issue)}>
          {t('rpt.mof.action.sign')}
        </button>
      ) : null}
      {state === 'unsigned' && !canSign && facts !== undefined ? <p className="rpt-g12-pending">{t('rpt.mof.action.noRight')}</p> : null}
    </div>
  );
}

function CopyLock({ issueId }: { issueId: string }) {
  const query = useSignature(issueId);
  return <LockPill open={query.data === undefined ? undefined : query.data.period_lock === null ? undefined : query.data.period_lock.open} />;
}

/**
 * RPT-05, the forms for the Ministry of Finance (G4-6): the four forms (week, month, quarter, year) with their status, the latest copy of each series with its signature and the lock of its period. A form that waits for
 * the official template can be read but not issued; the copy of a form that is ready is signed by its approver with a certificate of their own, and a test signature is shown as one and never counts for the Ministry.
 */
export default function MofFormsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <MofFormsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MofFormsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const catalogue = useCatalogue();
  const issues = useIssues({ headsOnly: true, demo: undefined });
  const locks = useLocks({ layoutCode: undefined, openOnly: true });
  const [signing, setSigning] = useState<Issue | undefined>(undefined);
  const data = catalogue.data;
  const forms = (data?.items ?? []).filter((entry) => isMofForm(entry.code));
  const copies = ((issues.data?.items ?? []) as Issue[]).filter((issue) => isMofForm(issue.layout_code));
  const state = useScreenState({ isLoading: catalogue.isLoading, error: data === undefined ? catalogue.error : undefined, data: data === undefined ? undefined : forms, isEmpty: (value) => (value as unknown[]).length === 0 });
  const canSign = holds(permissions, 'rpt.sign');

  const formColumns: DataTableColumn<Entry>[] = [
    {
      key: 'form',
      header: t('rpt.mof.col.form'),
      pinned: true,
      render: (entry) => (
        <>
          <strong data-testid={`form-${entry.code}`}>{entry.code}</strong>
          <div>{entry.name}</div>
        </>
      ),
    },
    { key: 'kind', header: t('rpt.mof.col.kind'), render: (entry) => t(`rpt.common.kind.${kindWord(entry.period_kind)}`) },
    {
      key: 'status',
      header: t('rpt.mof.col.status'),
      render: (entry) => (
        <>
          <StatusPill tone={entry.status === 'READY' ? 'success' : 'warning'}>{t(`rpt.common.status.${statusWord(entry.status)}`)}</StatusPill>
          {entry.status === 'PENDING_EXTERNAL' ? <p className="rpt-g12-pending" data-testid={`pending-${entry.code}`}>{t('rpt.mof.pending.text')}</p> : null}
        </>
      ),
    },
    { key: 'official', header: t('rpt.mof.col.official'), render: (entry) => t(`rpt.common.official.${statusWord(entry.official)}`) },
    { key: 'receiver', header: t('rpt.mof.col.receiver'), render: (entry) => entry.receiver },
    { key: 'issuable', header: t('rpt.mof.col.issuable'), render: (entry) => (entry.issuable && entry.status === 'READY' ? t('rpt.mof.issuable.yes') : t('rpt.mof.issuable.no')) },
  ];

  const copyColumns: DataTableColumn<Issue>[] = [
    { key: 'form', header: t('rpt.mof.col.form'), pinned: true, render: (issue) => <strong>{issue.layout_code}</strong> },
    { key: 'period', header: t('rpt.mof.col.period'), render: (issue) => issue.period_code },
    { key: 'revision', header: t('rpt.mof.col.revision'), render: (issue) => issue.revision },
    { key: 'hash', header: t('rpt.mof.col.hash'), render: (issue) => <HashLine sha={issue.sha256} /> },
    { key: 'when', header: t('rpt.mof.col.when'), render: (issue) => vietnamDateTime(issue.issued_at) },
    { key: 'signature', header: t('rpt.mof.col.signature'), render: (issue) => <CopyRow issue={issue} canSign={canSign} onSign={setSigning} /> },
    { key: 'lock', header: t('rpt.mof.col.lock'), render: (issue) => <CopyLock issueId={issue.id} /> },
  ];

  const rule = locks.data?.rule;
  const asOf = locks.data === undefined ? '' : vietnamDateTime(locks.data.as_of);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.mof.page.title')}</h1>
          <p>{t('rpt.mof.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[{ label: t('rpt.mof.context.scope'), value: tenant?.name ?? '–' }]}
        {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })}
        stale={(catalogue.isError && data !== undefined) || (issues.isError && issues.data !== undefined)}
      />
      {rule === undefined ? (
        <p className="callout" role="status" data-testid="rule-unknown">{locks.isError ? t('rpt.mof.rule.unreadable') : t('rpt.mof.rule.loading')}</p>
      ) : (
        <div className="rpt-g12-rule" data-testid="rule">
          <span className="rpt-g12-rule__item" data-testid="rule-receivers">
            {t('rpt.mof.rule.receivers', { receivers: rule.signature_required_receivers.join(', ') })}
            <RuleInfo name={t('rpt.mof.rule.receivers.name')} formula={t('rpt.mof.rule.receivers.formula')} asOf={asOf} rule={rule} />
          </span>
          <span className="rpt-g12-rule__item" data-testid="rule-lock">
            {t('rpt.mof.rule.lock', { event: t(`rpt.mof.rule.lockAfter.${rule.lock_after === 'SIGNED' ? 'signed' : 'accepted'}`) })}
            <RuleInfo name={t('rpt.mof.rule.lock.name')} formula={t('rpt.mof.rule.lock.formula')} asOf={asOf} rule={rule} />
          </span>
          <span className="rpt-g12-rule__item" data-testid="rule-open-locks">
            {t('rpt.mof.rule.openLocks', { count: locks.data?.items.length ?? 0 })}
            <RuleInfo name={t('rpt.mof.rule.openLocks.name')} formula={t('rpt.mof.rule.openLocks.formula')} asOf={asOf} rule={rule} />
          </span>
          {rule.unverified ? <StatusPill tone="warning">{t('rpt.lock.info.unverified')}</StatusPill> : null}
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        {data !== undefined && (
          <>
            <DataTable caption={t('rpt.mof.forms.caption')} columns={formColumns} rows={forms} rowKey={(entry) => entry.code} />
            <SectionCard title={t('rpt.mof.copies.title')}>
              {issues.isLoading ? (
                <p className="callout" role="status">{t('rpt.mof.copies.loading')}</p>
              ) : issues.isError ? (
                <p className="callout warning" role="alert" data-testid="copies-error">
                  {t('rpt.mof.copies.error')}{' '}
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void issues.refetch()}>
                    {t('rpt.mof.copies.retry')}
                  </button>
                </p>
              ) : copies.length === 0 ? (
                <p className="callout" data-testid="copies-empty">{t('rpt.mof.copies.empty')}</p>
              ) : (
                <DataTable caption={t('rpt.mof.copies.caption')} columns={copyColumns} rows={copies} rowKey={(issue) => issue.id} />
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      {signing === undefined ? null : <SignDialog issue={signing} onClose={() => setSigning(undefined)} />}
      <p className="rpt-muted">
        <Link to="/rpt/rpt-06">{t('rpt.mof.link.locks')}</Link>
      </p>
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
