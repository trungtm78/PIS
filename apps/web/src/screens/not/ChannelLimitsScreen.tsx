import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { channelLabel, statusLabel } from '../omni/channel/labels';
import type { AccountStatus } from '../omni/channel/model';
import './delivery/delivery.css';
import { useOverview, useSetLimits } from './limits/hooks';
import { limitsProblemMessage, problemMessage } from './limits/labels';
import { MANAGE_PERMISSION, READ_PERMISSION, describeProblem, formOf, limitsBody, limitsProblems, periodRange, utilisation } from './limits/model';
import type { AccountUse, LimitsForm, LimitsProblem, Overview } from './limits/model';

const money = (locale: string, value: string): string => `${new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US').format(Number(value))} ₫`;

/**
 * NOT-15: the cap and the budget of the channel accounts. For each account that is not closed: what it has sent today against its daily cap, what it has spent this month against its budget, and what waits because of them;
 * and the form that sets or takes off a limit, with a reason. A limit holds back ordinary messages only: a CRITICAL message is never held back by money, and the screen says so. The prices are estimates until the price
 * lists of the providers are in the plan.
 */
export default function ChannelLimitsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: switching tenant starts the screen over, so nothing typed for one is sent to the other.
  return <ChannelLimitsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ChannelLimitsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const range = useMemo(() => periodRange('day', new Date()), []);
  const overview = useOverview(range, canRead);
  const queryState = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: (data: unknown) => (data as Overview).accounts.length === 0 });
  const state = canRead ? queryState : 'denied';
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const accounts = overview.data?.accounts ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.limits.page.title')}</h1>
          <p>{t('not.limits.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('not.limits.rule.text')}</p>
        {done ? (
          <p className="callout" role="status" data-saved>
            {t('not.limits.done.saved')}
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void overview.refetch()}>
          {accounts.length === 0 ? (
            <p className="sub" role="status">
              {t('not.limits.list.none')}
            </p>
          ) : (
            <ul data-accounts>
              {accounts.map((account) => {
                const dayShare = utilisation(account.sentToday, account.dailySendCap);
                const monthShare = utilisation(account.spentMonthVnd, account.monthlyBudgetVnd);
                return (
                  <li key={account.id} data-account-id={account.id}>
                    <strong>{account.displayName}</strong> · {channelLabel(t, account.channel)} · {statusLabel(t, account.status as AccountStatus)}
                    <br />
                    <span data-day-use>{account.dailySendCap === undefined ? t('not.overview.use.noCap', { sent: account.sentToday }) : t('not.overview.use.cap', { sent: account.sentToday, cap: account.dailySendCap, share: Math.floor(dayShare ?? 0) })}</span>
                    {' · '}
                    <span data-month-use>
                      {account.monthlyBudgetVnd === undefined
                        ? t('not.overview.use.noBudget', { spent: money(locale, account.spentMonthVnd) })
                        : t('not.overview.use.budget', { spent: money(locale, account.spentMonthVnd), budget: money(locale, account.monthlyBudgetVnd), share: Math.floor(monthShare ?? 0) })}
                    </span>
                    {account.heldByLimit > 0 ? <span className="pill warn"> {t('not.overview.use.held', { count: account.heldByLimit })}</span> : null}
                    {canManage ? (
                      <>
                        {' '}
                        <button type="button" onClick={() => { setDone(false); setOpened(opened === account.id ? undefined : account.id); }}>
                          {t('not.limits.edit.action')}
                        </button>
                      </>
                    ) : null}
                    {opened === account.id ? <LimitsForm key={account.id} account={account} onSaved={() => { setDone(true); setOpened(undefined); }} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}

function LimitsForm({ account, onSaved }: { account: AccountUse; onSaved(): void }) {
  const { t } = useTranslation();
  const set = useSetLimits();
  // The version the form was opened on goes with the save: a change made by someone else meanwhile is a conflict and not undone.
  const [opened] = useState(account);
  const [form, setForm] = useState<LimitsForm>(() => formOf(account));
  const [shown, setShown] = useState<readonly LimitsProblem[]>([]);
  const problem = set.isError ? describeProblem(set.error) : undefined;
  const update = (change: Partial<LimitsForm>): void => setForm((current) => ({ ...current, ...change }));

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (set.isPending) return;
    const found = limitsProblems(form, opened);
    setShown(found);
    if (found.length > 0) return;
    set.reset();
    set.mutate({ accountId: opened.id, version: opened.version, body: limitsBody(form, opened), reason: form.reason.trim() }, { onSuccess: onSaved });
  };

  return (
    <form onSubmit={save} noValidate aria-label={t('not.limits.form.aria', { name: account.displayName })} className="card" data-limits-form>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {shown.map((item) => (
        <p key={item} className="callout warning" role="alert" data-form-problem={item}>
          {limitsProblemMessage(t, item)}
        </p>
      ))}
      <div className="field">
        <label htmlFor={`cap-${account.id}`}>{t('not.limits.form.cap.label')}</label>
        <input id={`cap-${account.id}`} inputMode="numeric" value={form.cap} disabled={form.clearCap} onChange={(event) => update({ cap: event.target.value })} />
        <label>
          <input type="checkbox" checked={form.clearCap} onChange={(event) => update({ clearCap: event.target.checked })} /> {t('not.limits.form.cap.clear')}
        </label>
      </div>
      <div className="field">
        <label htmlFor={`budget-${account.id}`}>{t('not.limits.form.budget.label')}</label>
        <input id={`budget-${account.id}`} inputMode="numeric" value={form.budget} disabled={form.clearBudget} onChange={(event) => update({ budget: event.target.value })} />
        <label>
          <input type="checkbox" checked={form.clearBudget} onChange={(event) => update({ clearBudget: event.target.checked })} /> {t('not.limits.form.budget.clear')}
        </label>
      </div>
      <div className="field">
        <label htmlFor={`reason-${account.id}`}>{t('not.limits.form.reason.label')}</label>
        <textarea id={`reason-${account.id}`} value={form.reason} onChange={(event) => update({ reason: event.target.value })} />
      </div>
      <div className="row gap">
        <button type="submit" className="primary" disabled={set.isPending}>
          {t('not.limits.form.submit.action')}
        </button>
      </div>
    </form>
  );
}
