import { useTranslation } from '../../i18n';
import { channelLabel } from '../not/delivery/labels';
import { useChannelHealth } from './channel-health';

/** The time of a delivery on the calendar and the clock of Vietnam, in the language of the reader. */
function momentText(iso: string, locale: string): string {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh' }).format(moment);
}

/**
 * The degraded-state banner of the home screen (ST-KERNEL-073, AC-ST-KERNEL-073-2): while the circuit breaker of a notification channel is open it names the channel and the time of its latest successful delivery,
 * and says that the work goes on. Nothing is shown while every channel is healthy, or when the state of the channels cannot be read.
 */
export function DegradedChannelsBanner() {
  const { t, locale } = useTranslation();
  const health = useChannelHealth();
  const channels = health.data ?? [];
  if (channels.length === 0) return null;
  return (
    <div role="status" className="card" data-testid="degraded-banner">
      <p>
        <strong>{t('home.degraded.title')}</strong>
      </p>
      <ul className="mne-lines">
        {channels.map((entry) => {
          const channel = channelLabel(t, entry.channel);
          return (
            <li key={entry.channel} data-channel={entry.channel} data-state={entry.state}>
              {entry.lastDeliveredAt === null ? t('home.degraded.never', { channel }) : t('home.degraded.sent', { channel, time: momentText(entry.lastDeliveredAt, locale) })}
            </li>
          );
        })}
      </ul>
      <p className="sub">{t('home.degraded.reassure')}</p>
    </div>
  );
}
