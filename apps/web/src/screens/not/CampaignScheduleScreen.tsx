import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import './delivery/delivery.css';
import { useCampaigns, useCancelCampaign, useSubmitCampaign } from './campaign/hooks';
import { problemMessage, purposeLabel, statusLabel } from './campaign/labels';
import { CANCELLABLE, MANAGE_PERMISSION, READ_PERMISSION, STATUSES, describeProblem, excludedTotal, reasonProblem, shortHash, validUntil } from './campaign/model';
import type { Campaign, CampaignStatus } from './campaign/model';

const ZONE = 'Asia/Ho_Chi_Minh';

/** An instant in the time zone the column names, whatever the zone of the browser. */
const instantIn = (locale: string, instant: string): string => {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: ZONE }).format(date);
};

/**
 * NOT-10: the schedule and the state of the broadcast campaigns. For each: when it goes out (a time, or as soon as it is approved), in which time zone, until when it may still be sent, to how many people, the hash of its preview and where
 * it stands. A previewed campaign is sent to approval with the hash of its preview, and a campaign that has not ended is cancelled with a reason: what is not yet sent is stopped. The sends are those of the time of the campaign, in
 * the time zone shown; a notification past its validity is not sent.
 */
export default function CampaignScheduleScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ScheduleContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScheduleContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const [filter, setFilter] = useState<CampaignStatus | ''>('');
  const campaigns = useCampaigns(filter === '' ? undefined : filter, canRead);
  const queryState = useScreenState({ isLoading: campaigns.isLoading, error: campaigns.error, data: campaigns.data, isEmpty: (data: unknown) => (data as Campaign[]).length === 0 });
  const state = canRead ? queryState : 'denied';
  const [done, setDone] = useState<'submitted' | 'cancelled' | undefined>(undefined);
  const segmentPath = routeById('NOT-09')?.path ?? '/not/not-09';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.schedule.page.title')}</h1>
          <p>{t('not.schedule.page.subtitle')}</p>
        </div>
        {canManage ? <Link to={segmentPath}>{t('not.schedule.new.link')}</Link> : null}
      </div>
      <div className="card">
        <p className="sub">{t('not.schedule.rule.text')}</p>
        <div className="field">
          <label htmlFor="campaign-filter">{t('not.schedule.filter.label')}</label>
          <select id="campaign-filter" value={filter} onChange={(event) => setFilter(event.target.value as CampaignStatus | '')}>
            <option value="">{t('not.schedule.filter.all')}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(t, status)}
              </option>
            ))}
          </select>
        </div>
        {done === undefined ? null : (
          <p className="callout" role="status" data-done={done}>
            {done === 'submitted' ? t('not.schedule.done.submitted') : t('not.schedule.done.cancelled')}
          </p>
        )}
        <StateBoundary state={state} onRetry={() => void campaigns.refetch()}>
          <table>
            <caption className="sr-only">{t('not.schedule.page.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('not.schedule.col.name')}</th>
                <th scope="col">{t('not.schedule.col.time')}</th>
                <th scope="col">{t('not.schedule.col.zone')}</th>
                <th scope="col">{t('not.schedule.col.valid')}</th>
                <th scope="col">{t('not.schedule.col.recipients')}</th>
                <th scope="col">{t('not.schedule.col.hash')}</th>
                <th scope="col">{t('not.schedule.col.status')}</th>
                <th scope="col">{t('not.schedule.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns.data ?? []).map((campaign) => (
                <ScheduleRow key={campaign.id} campaign={campaign} canManage={canManage} onDone={setDone} />
              ))}
            </tbody>
          </table>
        </StateBoundary>
      </div>
    </section>
  );
}

function ScheduleRow({ campaign, canManage, onDone }: { campaign: Campaign; canManage: boolean; onDone(what: 'submitted' | 'cancelled'): void }) {
  const { t, locale } = useTranslation();
  const submit = useSubmitCampaign();
  const cancel = useCancelCampaign();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const problem = submit.isError ? describeProblem(submit.error) : cancel.isError ? describeProblem(cancel.error) : undefined;
  const until = validUntil(campaign);
  const total = excludedTotal(campaign.excluded);

  const send = (): void => {
    if (submit.isPending || campaign.previewHash === undefined) return;
    submit.reset();
    submit.mutate({ campaign, previewHash: campaign.previewHash, reason: undefined }, { onSuccess: () => onDone('submitted') });
  };
  const stop = (event: FormEvent): void => {
    event.preventDefault();
    if (cancel.isPending) return;
    if (reasonProblem(reason)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    cancel.reset();
    cancel.mutate({ campaign, reason: reason.trim() }, { onSuccess: () => { setCancelling(false); setReason(''); onDone('cancelled'); } });
  };

  return (
    <tr data-campaign-id={campaign.id}>
      <th scope="row">
        {campaign.name}
        <br />
        <small>{purposeLabel(t, campaign.purpose)}</small>
      </th>
      <td data-time>{campaign.scheduledAt === undefined ? t('not.schedule.time.asap') : instantIn(locale, campaign.scheduledAt)}</td>
      <td data-zone>{ZONE}</td>
      <td data-valid>{until === undefined ? t('not.schedule.valid.none') : instantIn(locale, until.toISOString())}</td>
      <td data-recipients>
        {campaign.recipientCount === undefined ? t('not.schedule.recipients.none') : t('not.schedule.recipients.count', { count: campaign.recipientCount, excluded: total })}
        {campaign.notificationCount > 0 ? <small> · {t('not.schedule.recipients.made', { made: campaign.notificationCount, waiting: campaign.waitingCount })}</small> : null}
      </td>
      <td data-hash>{campaign.previewHash === undefined ? t('not.schedule.hash.none') : <code>{shortHash(campaign.previewHash)}</code>}</td>
      <td data-status={campaign.status}>{statusLabel(t, campaign.status)}</td>
      <td>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-problem>
            {problemMessage(t, problem)}
          </p>
        )}
        {canManage && campaign.status === 'Previewed' ? (
          <button type="button" onClick={send} disabled={submit.isPending} aria-label={t('not.schedule.submit.aria', { name: campaign.name })}>
            {t('not.schedule.submit.action')}
          </button>
        ) : null}
        {canManage && CANCELLABLE.includes(campaign.status) ? (
          <>
            <button type="button" onClick={() => setCancelling(!cancelling)} aria-label={t('not.schedule.cancel.aria', { name: campaign.name })}>
              {t('not.schedule.cancel.action')}
            </button>
            {cancelling ? (
              <form onSubmit={stop} noValidate aria-label={t('not.schedule.cancel.form.aria', { name: campaign.name })} data-cancel-form>
                {invalid ? (
                  <p className="callout warning" role="alert" data-reason-problem>
                    {t('not.schedule.cancel.reason.invalid')}
                  </p>
                ) : null}
                <label htmlFor={`cancel-reason-${campaign.id}`}>{t('not.schedule.cancel.reason.label')}</label>
                <textarea id={`cancel-reason-${campaign.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
                <button type="submit" className="primary" disabled={cancel.isPending}>
                  {t('not.schedule.cancel.confirm.action')}
                </button>
              </form>
            ) : null}
          </>
        ) : null}
      </td>
    </tr>
  );
}
