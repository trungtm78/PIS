import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Facts, HashLine } from '../../rpt/components';
import { vietnamDateTime } from '../../rpt/model';
import { LockPill, RuleInfo, SignaturePill } from './rptGov12Components';
import { useLocks, useSignature, useUnlock } from './rptGov12Hooks';
import { holds, shortId, signRefusalText } from './rptGov12Model';
import type { LockRow, LockRule } from './rptGov12Model';
import './rptGov12.css';

const LAYOUT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

/** The key of the word for a provider of signatures (camel case, as the keys of the catalogue are). */
const providerWord = (provider: string): string => (provider === 'REMOTE_CA' ? 'remoteCa' : provider === 'LOCAL_AGENT' ? 'localAgent' : 'mock');

function UnlockDialog({ lock, rule, onClose }: { lock: LockRow; rule: LockRule; onClose: () => void }) {
  const { t } = useTranslation();
  const unlock = useUnlock();
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('rpt.lock.unlock.title', { code: lock.layout_code, period: lock.period_code })}
      context={[
        { label: t('rpt.lock.col.locker'), value: shortId(lock.locked_by) },
        { label: t('rpt.lock.col.digest'), value: lock.digest_sha256.slice(0, 16) },
      ]}
      confirmLabel={t('rpt.lock.unlock.confirm')}
      cancelLabel={t('rpt.lock.unlock.cancel')}
      pending={unlock.isPending}
      reason={{ label: t('rpt.lock.unlock.reason'), required: true, minLength: rule.unlock_reason_min_chars, hint: t('rpt.lock.unlock.hint', { min: rule.unlock_reason_min_chars }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => unlock.mutate({ lockId: lock.id, version: lock.version, reason: (reason ?? '').trim() }, { onSuccess: onClose, onError: (failure) => setError(signRefusalText(t, failure)) })}
    />
  );
}

function SignatureDetail({ lock, onClose }: { lock: LockRow; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useSignature(lock.issue_id);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data: data ?? null, isEmpty: () => false });
  const dash = '–';
  return (
    <SectionCard
      title={t('rpt.lock.detail.title', { code: lock.layout_code, period: lock.period_code })}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('rpt.lock.detail.close')}
        </button>
      }
    >
      <div data-testid="signature-detail" className="rpt-g12-facts">
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {data !== undefined && (
            <>
              <p>
                <SignaturePill facts={data} />
              </p>
              {data.signature !== null && !data.signature.counts_for_delivery ? <p className="callout warning" role="status" data-testid="test-signature">{t('rpt.lock.detail.testNote')}</p> : null}
              <Facts
                items={[
                  { label: t('rpt.lock.detail.revision'), value: String(data.revision), testId: 'sig-revision' },
                  { label: t('rpt.lock.detail.digest'), value: <HashLine sha={data.digest_sha256} testId="sig-digest" /> },
                  { label: t('rpt.lock.detail.provider'), value: data.signature === null ? dash : t(`rpt.lock.provider.${providerWord(data.signature.provider)}`), testId: 'sig-provider' },
                  { label: t('rpt.lock.detail.signer'), value: data.signature === null ? dash : shortId(data.signature.signer_id), testId: 'sig-signer' },
                  { label: t('rpt.lock.detail.fingerprint'), value: data.signature === null ? dash : <HashLine sha={data.signature.certificate_fingerprint} testId="sig-fingerprint" /> },
                  { label: t('rpt.lock.detail.cms'), value: data.signature === null ? dash : <HashLine sha={data.signature.cms_sha256} testId="sig-cms" /> },
                  { label: t('rpt.lock.detail.signedAt'), value: data.signature === null ? dash : vietnamDateTime(data.signature.signed_at), testId: 'sig-at' },
                  { label: t('rpt.lock.detail.counts'), value: data.signature === null ? dash : data.signature.counts_for_delivery ? t('rpt.lock.detail.counts.yes') : t('rpt.lock.detail.counts.no'), testId: 'sig-counts' },
                  { label: t('rpt.lock.detail.receivers'), value: data.signature_required_receivers.join(', ') || dash, testId: 'sig-receivers' },
                ]}
              />
            </>
          )}
        </StateBoundary>
      </div>
    </SectionCard>
  );
}

/**
 * RPT-06, the locks of the report periods and the signatures of the copies (G4-6): which periods are locked, by whom, with which hash; a period is released by a second person with a reason of the length the rule asks for (the
 * rule is a default nobody confirmed until the tenant approves its own, and says so); the signature of a copy is shown with the whole digest, the hash of the CMS and whether it counts for the receiver.
 */
export default function PeriodLockScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PeriodLockContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PeriodLockContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [openOnly, setOpenOnly] = useState(true);
  const [layout, setLayout] = useState('');
  const [chosen, setChosen] = useState<LockRow | undefined>(undefined);
  const [unlocking, setUnlocking] = useState<LockRow | undefined>(undefined);
  const layoutCode = LAYOUT.test(layout) ? layout : undefined;
  const query = useLocks({ layoutCode, openOnly });
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const canUnlock = holds(permissions, 'rpt.lock.unlock');
  const layoutInvalid = layout !== '' && layoutCode === undefined;
  const asOf = data === undefined ? '' : vietnamDateTime(data.as_of);

  const columns: DataTableColumn<LockRow>[] = [
    { key: 'form', header: t('rpt.lock.col.form'), pinned: true, render: (lock) => <strong>{lock.layout_code}</strong> },
    { key: 'period', header: t('rpt.lock.col.period'), render: (lock) => lock.period_code },
    { key: 'state', header: t('rpt.lock.col.state'), render: (lock) => <LockPill open={lock.open} /> },
    { key: 'digest', header: t('rpt.lock.col.digest'), render: (lock) => <HashLine sha={lock.digest_sha256} /> },
    { key: 'locker', header: t('rpt.lock.col.locker'), render: (lock) => <code>{shortId(lock.locked_by)}</code> },
    { key: 'lockedAt', header: t('rpt.lock.col.lockedAt'), render: (lock) => vietnamDateTime(lock.locked_at) },
    { key: 'unlocker', header: t('rpt.lock.col.unlocker'), render: (lock) => (lock.unlocked_by === null ? '–' : <code>{shortId(lock.unlocked_by)}</code>) },
    { key: 'reason', header: t('rpt.lock.col.reason'), render: (lock) => lock.unlock_reason ?? '–' },
    {
      key: 'actions',
      header: t('rpt.lock.col.actions'),
      render: (lock) => (
        <span className="rpt-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`signature-${lock.id}`} onClick={() => setChosen(lock)}>
            {t('rpt.lock.action.signature')}
          </button>
          {lock.open && canUnlock ? (
            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid={`unlock-${lock.id}`} onClick={() => setUnlocking(lock)}>
              {t('rpt.lock.action.unlock')}
            </button>
          ) : null}
          {lock.open && !canUnlock ? <span className="rpt-muted" data-testid={`no-unlock-${lock.id}`}>{t('rpt.lock.action.noRight')}</span> : null}
        </span>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.lock.page.title')}</h1>
          <p>{t('rpt.lock.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('rpt.lock.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf })} stale={query.isError && data !== undefined} />
      {data === undefined ? null : (
        <div className="rpt-g12-rule" data-testid="rule">
          <span className="rpt-g12-rule__item" data-testid="rule-minchars">
            {t('rpt.lock.rule.minChars', { count: data.rule.unlock_reason_min_chars })}
            <RuleInfo name={t('rpt.lock.rule.minChars.name')} formula={t('rpt.lock.rule.minChars.formula')} asOf={asOf} rule={data.rule} />
          </span>
          <span className="rpt-g12-rule__item" data-testid="rule-count">
            {t('rpt.lock.rule.count', { count: data.items.length })}
            <RuleInfo name={t('rpt.lock.rule.count.name')} formula={t('rpt.lock.rule.count.formula')} asOf={asOf} rule={data.rule} />
          </span>
          {data.rule.unverified ? <StatusPill tone="warning">{t('rpt.lock.info.unverified')}</StatusPill> : null}
        </div>
      )}
      <div className="rpt-filter">
        <label>
          <input type="checkbox" checked={openOnly} data-testid="open-only" onChange={(event) => setOpenOnly(event.target.checked)} /> {t('rpt.lock.filter.open')}
        </label>
        <label>
          {t('rpt.lock.filter.layout')}{' '}
          <input type="text" maxLength={60} value={layout} data-testid="filter-layout" aria-invalid={layoutInvalid} onChange={(event) => setLayout(event.target.value.trim())} />
        </label>
        {layoutInvalid ? <span className="callout warning" role="alert" data-testid="layout-invalid">{t('rpt.lock.filter.layout.invalid')}</span> : null}
      </div>
      {chosen === undefined ? null : <SignatureDetail key={chosen.id} lock={chosen} onClose={() => setChosen(undefined)} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <DataTable caption={t('rpt.lock.table.caption')} columns={columns} rows={data.items} rowKey={(lock) => lock.id} />
            {data.has_more ? <p className="callout" role="status">{t('rpt.lock.list.more')}</p> : null}
          </>
        )}
      </StateBoundary>
      {unlocking === undefined || data === undefined ? null : <UnlockDialog lock={unlocking} rule={data.rule} onClose={() => setUnlocking(undefined)} />}
      <p className="rpt-muted">
        <Link to="/rpt/rpt-05">{t('rpt.lock.link.forms')}</Link>
      </p>
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
