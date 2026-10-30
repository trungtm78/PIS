import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import '../not/delivery/delivery.css';
import { useAccounts, useConnectAccount } from './channel/hooks';
import { channelLabel, fieldProblemMessage, problemMessage, statusLabel, statusPill } from './channel/labels';
import { CHANNELS, MANAGE_PERMISSION, READ_PERMISSION, STATUSES, WEBHOOK_CHANNELS, connectBody, describeProblem, emptyConnectForm, formProblems } from './channel/model';
import type { AccountPage, ConnectForm, FormField } from './channel/model';

const DETAIL_ROUTE = 'OMNI-06';

/** The path of the configuration of one account. */
export const configPathOf = (id: string): string => `${routeById(DETAIL_ROUTE)?.path ?? '/omni/omni-06'}?id=${encodeURIComponent(id)}`;

/**
 * OMNI-05: the channel accounts of the tenant and the form that connects a new one. An account is connected with the references of its secrets (never the secrets), starts as waiting for verification, and sends and
 * receives only once it has been verified. A secret is never shown: a card says that it is configured.
 */
export default function ChannelConnectScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and its notices belong to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <ChannelConnectContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ChannelConnectContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const pages = useAccounts({ status, channel }, canRead);
  const connect = useConnectAccount();
  const items = ((pages.data?.pages ?? []) as AccountPage[]).flatMap((page) => page.items);
  const queryState = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data });
  const state = canRead ? queryState : 'denied';
  const [form, setForm] = useState<ConnectForm>(emptyConnectForm);
  const [shown, setShown] = useState<readonly FormField[]>([]);
  const [saved, setSaved] = useState(false);
  const problem = connect.isError ? describeProblem(connect.error) : undefined;
  const day = (value: string): string => instantText(locale, value);
  const update = (change: Partial<ConnectForm>): void => setForm((current) => ({ ...current, ...change }));
  const hasWebhook = WEBHOOK_CHANNELS.includes(form.channel);

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (connect.isPending || !canManage) return;
    const found = formProblems(form);
    setShown(found);
    if (found.length > 0) return;
    setSaved(false);
    connect.reset();
    connect.mutate(
      { body: connectBody(form) },
      {
        onSuccess: () => {
          setSaved(true);
          setForm(emptyConnectForm());
        },
      },
    );
  };

  const fieldError = (field: FormField) =>
    shown.includes(field) ? (
      <small role="alert" className="field-error" id={`connect-${field}-error`}>
        {fieldProblemMessage(t, field)}
      </small>
    ) : null;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.channel.page.title')}</h1>
          <p>{t('omni.channel.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('omni.channel.rule.text')}</p>
        <div className="filters">
          <div>
            <label htmlFor="channel-status">{t('omni.channel.filter.status.label')}</label>
            <select id="channel-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">{t('omni.channel.filter.all')}</option>
              {STATUSES.map((name) => (
                <option key={name} value={name}>
                  {statusLabel(t, name)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="channel-channel">{t('omni.channel.filter.channel.label')}</label>
            <select id="channel-channel" value={channel} onChange={(event) => setChannel(event.target.value)}>
              <option value="">{t('omni.channel.filter.all')}</option>
              {CHANNELS.map((name) => (
                <option key={name} value={name}>
                  {channelLabel(t, name)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('omni.channel.list.none')}
            </p>
          ) : (
            <div className="row gap wrap" data-accounts>
              {items.map((account) => (
                <article key={account.id} className="card" data-account-id={account.id} data-status={account.status} aria-label={account.displayName}>
                  <h3>{account.displayName}</h3>
                  <p>
                    <span className={statusPill(account.status)}>{statusLabel(t, account.status)}</span> · {channelLabel(t, account.channel)}
                  </p>
                  <p className="sub">
                    {t('omni.channel.card.external')}: <code>{account.externalAccountId}</code>
                  </p>
                  <p className="sub" data-verified-at>
                    {t('omni.channel.card.verified')}: {account.verifiedAt === undefined ? t('omni.channel.card.neverVerified') : day(account.verifiedAt)}
                  </p>
                  <p className="sub" data-secrets>
                    {t('omni.channel.card.credential')}: {account.credentialConfigured ? t('omni.channel.secret.configured') : t('omni.channel.secret.missing')}
                    {' · '}
                    {t('omni.channel.card.webhook')}: {WEBHOOK_CHANNELS.includes(account.channel) ? (account.webhookConfigured ? t('omni.channel.secret.configured') : t('omni.channel.secret.missing')) : t('omni.channel.secret.notNeeded')}
                  </p>
                  <Link to={configPathOf(account.id)}>{t('omni.channel.card.open.action')}</Link>
                </article>
              ))}
            </div>
          )}
          {pages.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {t('omni.channel.list.more.action')}
              </button>
            </div>
          ) : null}
        </StateBoundary>
      </div>
      {canManage ? (
        <form onSubmit={save} noValidate aria-label={t('omni.channel.form.aria')} className="card">
          <h2>{t('omni.channel.form.title')}</h2>
          <p className="sub">{t('omni.channel.form.hint')}</p>
          {saved ? (
            <p className="callout" role="status" data-saved>
              {t('omni.channel.done.connected')}
            </p>
          ) : null}
          {problem === undefined ? null : (
            <p className="callout warning" role="alert" data-problem>
              {problemMessage(t, problem)}
            </p>
          )}
          <div className="field">
            <label htmlFor="connect-channel">{t('omni.channel.form.channel.label')}</label>
            <select id="connect-channel" value={form.channel} onChange={(event) => update({ channel: event.target.value as ConnectForm['channel'] })}>
              {CHANNELS.map((name) => (
                <option key={name} value={name}>
                  {channelLabel(t, name)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="connect-external">{t('omni.channel.form.externalId.label')}</label>
            <input id="connect-external" value={form.externalAccountId} aria-invalid={shown.includes('externalAccountId') ? true : undefined} onChange={(event) => update({ externalAccountId: event.target.value })} />
            {fieldError('externalAccountId')}
          </div>
          <div className="field">
            <label htmlFor="connect-name">{t('omni.channel.form.displayName.label')}</label>
            <input id="connect-name" value={form.displayName} aria-invalid={shown.includes('displayName') ? true : undefined} onChange={(event) => update({ displayName: event.target.value })} />
            {fieldError('displayName')}
          </div>
          <div className="field">
            <label htmlFor="connect-credential">{t('omni.channel.form.credential.label')}</label>
            <input id="connect-credential" value={form.credentialSecretRef} autoComplete="off" aria-invalid={shown.includes('credentialSecretRef') ? true : undefined} onChange={(event) => update({ credentialSecretRef: event.target.value })} />
            <small className="sub">{t('omni.channel.form.secret.hint')}</small>
            {fieldError('credentialSecretRef')}
          </div>
          {hasWebhook ? (
            <div className="field">
              <label htmlFor="connect-webhook">{t('omni.channel.form.webhook.label')}</label>
              <input id="connect-webhook" value={form.webhookSecretRef} autoComplete="off" aria-invalid={shown.includes('webhookSecretRef') ? true : undefined} onChange={(event) => update({ webhookSecretRef: event.target.value })} />
              {fieldError('webhookSecretRef')}
            </div>
          ) : (
            <p className="sub" data-no-webhook>
              {t('omni.channel.form.noWebhook')}
            </p>
          )}
          <div className="row gap">
            <button type="submit" className="primary" disabled={connect.isPending}>
              {t('omni.channel.form.submit.action')}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
