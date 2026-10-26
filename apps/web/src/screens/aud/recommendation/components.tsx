import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { concludable } from '../conclusion/model';
import { useEngagements } from '../hooks';
import { engagementStatusLabel } from '../labels';
import { formatVnd } from '../conclusion/model';
import { lateDays } from './model';
import type { BoardItem, Caller } from './model';

const NO_FILTER = { status: '', type: '' } as const;

/** Who is asking, for the buttons: the membership of the session, its permissions and whether the tenant is read only (the server judges every request again). */
export function useCaller(): Caller {
  const { tenant, permissions, mode } = useSession();
  return { userId: tenant?.membershipId, permissions, mode };
}

/** The engagement the list is narrowed to: the `engagement` of the address, so that a link from the file of an engagement can lead here; none shows all in scope. */
export function EngagementFilter({ selected }: { selected: string | undefined }) {
  const { t } = useTranslation();
  const [, setParams] = useSearchParams();
  const list = useEngagements(NO_FILTER);
  const options = (list.data ?? []).filter((engagement) => concludable(engagement.status) || engagement.id === selected);
  return (
    <div className="field">
      <label htmlFor="remediation-engagement">{t('aud.remediation.filter.engagement.label')}</label>
      <select id="remediation-engagement" value={selected ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { engagement: event.target.value })}>
        <option value="">{t('aud.remediation.filter.engagement.all')}</option>
        {options.map((engagement) => (
          <option key={engagement.id} value={engagement.id}>
            {t('aud.conclusion.picker.option', { code: engagement.code, status: engagementStatusLabel(t, engagement.status) })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The day a recommendation is due, and how late it is: the days and the day it was due, in words and not by colour alone (BR-AUD-06). */
export function DueDay({ item, today }: { item: Pick<BoardItem, 'dueOn' | 'status'>; today: string }) {
  const { t } = useTranslation();
  if (item.dueOn === null) return <span>—</span>;
  const days = lateDays(item, today);
  return (
    <span>
      {item.dueOn}
      {days > 0 ? (
        <span className="aud-badge warning" data-testid="late-badge">
          {t('aud.remediation.late.text', { days, due: item.dueOn })}
        </span>
      ) : null}
    </span>
  );
}

/** What was recommended and what has been recovered of it, in dong; a recommendation that is not financial has no money. */
export function Money({ item }: { item: Pick<BoardItem, 'amountVnd' | 'recoveredVnd'> }) {
  const { t } = useTranslation();
  if (item.amountVnd === null) return <span>—</span>;
  return <span>{t('aud.remediation.money.text', { recovered: formatVnd(item.recoveredVnd), amount: formatVnd(item.amountVnd) })}</span>;
}
