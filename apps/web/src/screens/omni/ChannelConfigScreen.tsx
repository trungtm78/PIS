import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import { ReasonPanel } from '../not/delivery/ReasonPanel';
import '../not/delivery/delivery.css';
import { useAccount, useDisableAccount, useUpdateAccount, useVerifyAccount } from './channel/hooks';
import { channelLabel, problemMessage, statusLabel, statusPill, verificationErrorLabel } from './channel/labels';
import { AUTO_REPLY_MAX, MANAGE_PERMISSION, READ_PERMISSION, WEBHOOK_CHANNELS, canDisable, canEdit, canVerify, describeProblem, isReasonValid, isWaiting } from './channel/model';
import type { AccountView } from './channel/model';

type Acting = 'verify' | 'disable';

/**
 * OMNI-06: one channel account. It shows the facts (never a secret, only the word "configured"), what the last verification said, and lets the supervisor change the name, the reply sent outside working hours and the calendar of
 * the account, ask for a verification, or close the account. A closed account is read, not changed: it neither sends nor receives, and a new account is connected instead. While a verification waits for the provider the
 * screen reads the account again, so the answer shows without a reload.
 */
export default function ChannelConfigScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The panels and the form belong to one membership and one account: switching tenant, or opening another account, starts the screen over, so nothing typed for one is sent to the other.
  return <ChannelConfigContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('id') ?? 'none'}`} route={route} />;
}

function ChannelConfigContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const id = params.get('id') ?? undefined;
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const account = useAccount(id, canRead);
  const verify = useVerifyAccount();
  const disable = useDisableAccount();
  const update = useUpdateAccount();
  const queryState = useScreenState({ isLoading: account.isLoading, error: account.error, data: account.data });
  const state = canRead ? queryState : 'denied';
  const [acting, setActing] = useState<Acting | undefined>(undefined);
  const [epoch, setEpoch] = useState(0);
  // The clock the screen judges a waiting verification by: reading the account again changes nothing on the screen when the answer is the same, so a verification that has waited too long needs a tick of its own.
  const [now, setNow] = useState(() => Date.now());
  const waiting = account.data !== undefined && isWaiting(account.data);
  useEffect(() => {
    if (!waiting) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [waiting]);
  const [done, setDone] = useState<'verify' | 'disable' | 'saved' | undefined>(undefined);
  const day = (value: string): string => instantText(locale, value);
  const listPath = routeById('OMNI-05')?.path ?? '/omni/omni-05';
  const current = account.data;
  const actionProblem = verify.isError ? describeProblem(verify.error) : disable.isError ? describeProblem(disable.error) : undefined;

  const confirm = (reason: string): void => {
    if (current === undefined || verify.isPending || disable.isPending) return;
    const input = { accountId: current.id, version: current.version, reason };
    if (acting === 'verify') {
      verify.mutate(input, {
        onSuccess: () => {
          setDone('verify');
          setActing(undefined);
        },
      });
    } else if (acting === 'disable') {
      disable.mutate(input, {
        onSuccess: () => {
          setDone('disable');
          setActing(undefined);
        },
      });
    }
  };

  const open = (what: Acting): void => {
    verify.reset();
    disable.reset();
    setDone(undefined);
    setActing(what);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.config.page.title')}</h1>
          <p>{t('omni.config.page.subtitle')}</p>
        </div>
        <Link to={listPath}>{t('omni.config.back.action')}</Link>
      </div>
      {id === undefined ? (
        <p className="callout" role="status" data-no-selection>
          {t('omni.config.noSelection')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void account.refetch()}>
          {current === undefined ? (
            <p className="callout warning" role="alert">
              {t('omni.channel.problem.notFound')}
            </p>
          ) : (
            <>
              <AccountFacts account={current} day={day} />
              {done === undefined ? null : (
                <p className="callout" role="status" data-done={done}>
                  {done === 'verify' ? t('omni.config.done.verify') : done === 'disable' ? t('omni.config.done.disable') : t('omni.config.done.saved')}
                </p>
              )}
              {current.status === 'Disabled' ? (
                <p className="callout warning" role="status" data-channel-disabled>
                  {t('omni.config.disabled.note')}
                </p>
              ) : null}
              {current.status === 'CredentialExpired' ? (
                <p className="callout warning" role="status" data-credential-expired>
                  {t('omni.config.expired.note')}
                </p>
              ) : null}
              {isWaiting(current) ? (
                <p className="callout" role="status" data-waiting>
                  {t('omni.config.waiting.note')}
                </p>
              ) : null}
              {current.verificationError === undefined || current.status === 'Active' || current.status === 'Disabled' ? null : (
                <p className="callout warning" role="alert" data-verification-error>
                  {t('omni.config.error.note', { reason: verificationErrorLabel(t, current.verificationError) })}
                </p>
              )}
              {canManage && canEdit(current) ? (
                <EditForm
                  key={`${current.id}:${epoch}`}
                  account={current}
                  update={update}
                  onSaved={() => {
                    setDone('saved');
                    // The account was read again before this runs: the form starts over on the version just saved.
                    setEpoch((value) => value + 1);
                  }}
                />
              ) : null}
              {canManage ? (
                <div className="row gap">
                  {canVerify(current, now) ? (
                    <button type="button" className="primary" onClick={() => open('verify')}>
                      {t('omni.config.verify.action')}
                    </button>
                  ) : null}
                  {canDisable(current) ? (
                    <button type="button" onClick={() => open('disable')}>
                      {t('omni.config.disable.action')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {acting === undefined ? null : (
                <ReasonPanel
                  key={acting}
                  testId={`channel-${acting}`}
                  title={acting === 'verify' ? t('omni.config.verify.title') : t('omni.config.disable.title')}
                  hint={acting === 'verify' ? t('omni.config.verify.hint') : t('omni.config.disable.hint')}
                  risk={acting === 'disable' ? t('omni.config.disable.risk') : undefined}
                  reasonLabel={t('omni.config.reason.label')}
                  reasonError={t('omni.config.reason.error')}
                  confirmLabel={t('omni.config.confirm.action')}
                  dismissLabel={t('omni.config.dismiss.action')}
                  pending={verify.isPending || disable.isPending}
                  problem={actionProblem === undefined ? undefined : problemMessage(t, actionProblem)}
                  onConfirm={confirm}
                  onDismiss={() => setActing(undefined)}
                />
              )}
            </>
          )}
        </StateBoundary>
      )}
    </section>
  );
}

function AccountFacts({ account, day }: { account: AccountView; day: (value: string) => string }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-account-facts data-status={account.status}>
      <h2>{account.displayName}</h2>
      <dl>
        <dt>{t('omni.config.fact.channel')}</dt>
        <dd>{channelLabel(t, account.channel)}</dd>
        <dt>{t('omni.config.fact.status')}</dt>
        <dd>
          <span className={statusPill(account.status)}>{statusLabel(t, account.status)}</span>
        </dd>
        <dt>{t('omni.channel.card.external')}</dt>
        <dd>
          <code>{account.externalAccountId}</code>
        </dd>
        <dt>{t('omni.channel.card.verified')}</dt>
        <dd data-verified-at>{account.verifiedAt === undefined ? t('omni.channel.card.neverVerified') : day(account.verifiedAt)}</dd>
        <dt>{t('omni.channel.card.credential')}</dt>
        <dd data-credential>{account.credentialConfigured ? t('omni.channel.secret.configured') : t('omni.channel.secret.missing')}</dd>
        <dt>{t('omni.channel.card.webhook')}</dt>
        <dd data-webhook>{WEBHOOK_CHANNELS.includes(account.channel) ? (account.webhookConfigured ? t('omni.channel.secret.configured') : t('omni.channel.secret.missing')) : t('omni.channel.secret.notNeeded')}</dd>
        <dt>{t('omni.config.fact.created')}</dt>
        <dd>{day(account.createdAt)}</dd>
      </dl>
    </div>
  );
}

function EditForm({ account: latest, update, onSaved }: { account: AccountView; update: ReturnType<typeof useUpdateAccount>; onSaved(): void }) {
  const { t } = useTranslation();
  // What the form was opened on, and the version of it: if someone else changes the account meanwhile, the save goes with the version read here and is refused as a conflict instead of undoing their change.
  const [account, setAccount] = useState(latest);
  const [name, setName] = useState(account.displayName);
  const [reply, setReply] = useState(account.autoReplyText ?? '');
  const [calendar, setCalendar] = useState(account.calendarCode ?? '');
  const [reason, setReason] = useState('');
  const untouched = name === account.displayName && reply === (account.autoReplyText ?? '') && calendar === (account.calendarCode ?? '') && reason === '';
  // A form nobody has written in follows the account (the verification asked for from this screen moves its version too); once something is typed the form keeps the version it was opened on.
  useEffect(() => {
    if (!untouched || latest.version === account.version) return;
    setAccount(latest);
    setName(latest.displayName);
    setReply(latest.autoReplyText ?? '');
    setCalendar(latest.calendarCode ?? '');
  }, [untouched, latest, account.version]);
  const [invalid, setInvalid] = useState(false);
  const problem = update.isError ? describeProblem(update.error) : undefined;

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (update.isPending) return;
    const bad = name.trim() === '' || name.trim().length > 120 || reply.length > AUTO_REPLY_MAX || !isReasonValid(reason);
    setInvalid(bad);
    if (bad) return;
    const changes: Record<string, unknown> = {};
    if (name.trim() !== account.displayName) changes.display_name = name.trim();
    if (reply.trim() !== (account.autoReplyText ?? '')) changes.auto_reply_text = reply.trim();
    if (calendar.trim() !== (account.calendarCode ?? '')) changes.calendar_code = calendar.trim();
    if (Object.keys(changes).length === 0) {
      setInvalid(true);
      return;
    }
    update.reset();
    update.mutate({ accountId: account.id, version: account.version, reason: reason.trim(), changes }, { onSuccess: () => { setReason(''); onSaved(); } });
  };

  return (
    <form onSubmit={save} noValidate aria-label={t('omni.config.edit.aria')} className="card" data-edit>
      <h2>{t('omni.config.edit.title')}</h2>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {invalid ? (
        <p className="callout warning" role="alert" data-invalid>
          {t('omni.config.edit.invalid')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="config-name">{t('omni.config.edit.displayName.label')}</label>
        <input id="config-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="config-reply">{t('omni.config.edit.autoReply.label')}</label>
        <textarea id="config-reply" value={reply} maxLength={AUTO_REPLY_MAX + 1} onChange={(event) => setReply(event.target.value)} />
        <small className="sub">{t('omni.config.edit.autoReply.hint', { max: AUTO_REPLY_MAX })}</small>
      </div>
      <div className="field">
        <label htmlFor="config-calendar">{t('omni.config.edit.calendar.label')}</label>
        <input id="config-calendar" value={calendar} onChange={(event) => setCalendar(event.target.value)} />
        <small className="sub">{t('omni.config.edit.calendar.hint')}</small>
      </div>
      <div className="field">
        <label htmlFor="config-reason">{t('omni.config.reason.label')}</label>
        <textarea id="config-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <div className="row gap">
        <button type="submit" className="primary" disabled={update.isPending}>
          {t('omni.config.edit.save.action')}
        </button>
      </div>
    </form>
  );
}
