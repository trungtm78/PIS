import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { ReasonPanel } from './delivery/ReasonPanel';
import { consentsOf, useConsentPages, useGrantConsent, useWithdrawConsent } from './consents/hooks';
import { channelName, problemMessage, purposeName, statusName, statusPill } from './consents/labels';
import { CONSENT_CHANNELS, CONSENT_PURPOSES, CONSENT_TEXT_VERSION, isLive, problemReasonOf } from './consents/model';
import type { ConsentChannel, ConsentItem, ConsentPurpose } from './consents/model';
import './consents/consents.css';

/**
 * NOT-17: the consent history of the member (BR-NOT-07). The member gives a consent for a channel and a purpose against the current text, sees every consent
 * they gave and every one they withdrew, and withdraws one after confirming it. A withdrawal counts at once for every message that has not gone out. The
 * inbox is shown as locked: the duty messages in the application need no consent and cannot be switched off here.
 */
export default function ConsentHistoryScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const readOnly = mode === 'READ_ONLY';
  const pages = useConsentPages();
  const grant = useGrantConsent();
  const withdraw = useWithdrawConsent();
  const items = useMemo(() => consentsOf(pages.data), [pages.data]);
  const state = useScreenState({ isLoading: pages.isLoading, error: items === undefined ? pages.error : undefined, data: items });
  const [target, setTarget] = useState<ConsentItem | undefined>(undefined);
  const all = items ?? [];

  const confirmWithdraw = (reason: string): void => {
    if (target === undefined) return;
    withdraw.mutate({ id: target.id, version: target.version, reason }, { onSuccess: () => setTarget(undefined) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-consents">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.consent.page.title')}</h1>
          <p>{t('scr2.not.consent.page.subtitle')}</p>
        </div>
      </div>

      <div className="card" data-testid="locked-channels">
        <h2>{t('not.consent.locked.title')}</h2>
        <ul className="locked-list">
          <li>
            <span className="lock" aria-hidden="true">
              {'🔒'}
            </span>
            <span>
              <strong>{t('not.consent.locked.inApp.name')}</strong>
              <small>{t('not.consent.locked.inApp.hint')}</small>
            </span>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>{t('not.consent.history.title')}</h2>
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('not.consent.col.channel')}</th>
                  <th>{t('not.consent.col.purpose')}</th>
                  <th>{t('not.consent.col.status')}</th>
                  <th>{t('not.consent.col.since')}</th>
                  <th>{t('not.consent.col.text')}</th>
                  <th>{t('not.consent.withdraw.title')}</th>
                </tr>
              </thead>
              <tbody>
                {all.map((item) => (
                  <tr key={item.id} data-consent-id={item.id}>
                    <td>{channelName(t, item.channel)}</td>
                    <td>{purposeName(t, item.purpose)}</td>
                    <td>
                      <span className={statusPill(item.status)}>{statusName(t, item.status)}</span>
                    </td>
                    <td>
                      {item.revokedAt === undefined
                        ? t('not.consent.since.granted', { at: instantText(locale, item.effectiveAt) })
                        : t('not.consent.since.ended', { from: instantText(locale, item.effectiveAt), to: instantText(locale, item.revokedAt) })}
                    </td>
                    <td>{item.textVersion}</td>
                    <td>
                      {item.status === 'Granted' ? (
                        <button type="button" disabled={readOnly} onClick={() => setTarget(item)}>
                          {t('not.consent.withdraw.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages.hasNextPage ? (
            <button type="button" className="more" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {t('not.consent.history.more.action')}
            </button>
          ) : null}
        </StateBoundary>
        {target === undefined ? null : (
          <ReasonPanel
            testId="withdraw-panel"
            title={t('not.consent.withdraw.title')}
            hint={t('not.consent.withdraw.hint', { channel: channelName(t, target.channel), purpose: purposeName(t, target.purpose) })}
            risk={t('not.consent.withdraw.risk')}
            reasonLabel={t('not.consent.withdraw.reason.label')}
            reasonError={t('not.consent.withdraw.reason.error')}
            confirmLabel={t('not.consent.withdraw.confirm.action')}
            dismissLabel={t('not.consent.withdraw.dismiss.action')}
            pending={withdraw.isPending}
            problem={withdraw.isError ? problemMessage(t, problemReasonOf(withdraw.error)) : undefined}
            onConfirm={confirmWithdraw}
            onDismiss={() => {
              withdraw.reset();
              setTarget(undefined);
            }}
          />
        )}
      </div>

      <GrantForm
        items={all}
        disabled={readOnly || grant.isPending}
        readOnly={readOnly}
        problem={grant.isError ? problemMessage(t, problemReasonOf(grant.error)) : undefined}
        onGrant={(channel, purpose) => grant.mutate({ channel, purpose })}
        granted={grant.isSuccess}
      />
    </section>
  );
}

interface GrantFormProps {
  items: readonly ConsentItem[];
  disabled: boolean;
  readOnly: boolean;
  problem: string | undefined;
  granted: boolean;
  onGrant(channel: ConsentChannel, purpose: ConsentPurpose): void;
}

function GrantForm({ items, disabled, readOnly, problem, granted, onGrant }: GrantFormProps) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<ConsentChannel>('SMS');
  const [purpose, setPurpose] = useState<ConsentPurpose>('OPERATIONAL');
  const [agreed, setAgreed] = useState(false);
  const [missing, setMissing] = useState(false);
  const live = isLive(items, channel, purpose);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!agreed) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onGrant(channel, purpose);
    setAgreed(false);
  };

  return (
    <form className="card grant-form" onSubmit={submit} aria-label={t('not.consent.grant.title')} data-testid="grant-form">
      <h2>{t('not.consent.grant.title')}</h2>
      <p className="sub">{t('not.consent.grant.hint')}</p>
      {readOnly ? (
        <p className="callout warning" role="status">
          {t('not.consent.readOnly.message')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="grant-problem">
          {problem}
        </p>
      )}
      {granted && problem === undefined ? (
        <p className="callout" role="status" data-testid="grant-done">
          {t('not.consent.grant.done')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="consent-channel">{t('not.consent.grant.channel.label')}</label>
        <select id="consent-channel" value={channel} onChange={(event) => setChannel(event.target.value as ConsentChannel)} disabled={disabled}>
          {CONSENT_CHANNELS.map((name) => (
            <option key={name} value={name}>
              {channelName(t, name)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="consent-purpose">{t('not.consent.grant.purpose.label')}</label>
        <select id="consent-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value as ConsentPurpose)} disabled={disabled}>
          {CONSENT_PURPOSES.map((name) => (
            <option key={name} value={name}>
              {purposeName(t, name)}
            </option>
          ))}
        </select>
      </div>
      {live ? (
        <p className="callout" role="status" data-testid="grant-live">
          {t('scr2.not.consent.grantLive.message')}
        </p>
      ) : null}
      <div className="field">
        <label className="agree" htmlFor="consent-agree">
          <input id="consent-agree" type="checkbox" checked={agreed} disabled={disabled} aria-invalid={missing ? true : undefined} onChange={(event) => setAgreed(event.target.checked)} />
          {t('not.consent.grant.agree.label', { channel: channelName(t, channel), purpose: purposeName(t, purpose), version: CONSENT_TEXT_VERSION })}
        </label>
        {missing ? (
          <small role="alert" className="field-error">
            {t('not.consent.grant.agree.error')}
          </small>
        ) : null}
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={disabled || live}>
          {t('not.consent.grant.confirm.action')}
        </button>
      </div>
    </form>
  );
}
