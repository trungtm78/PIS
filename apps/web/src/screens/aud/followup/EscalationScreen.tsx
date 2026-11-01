import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import '../aud.css';
import { todayInVietnam } from '../model';
import { DueDay, EngagementFilter } from '../recommendation/components';
import { useRecommendationBoard } from '../recommendation/hooks';
import { levelLabel } from './labels';
import { BOARD_PATH, LEVELS, READ_PERMISSION, SECOND_LEVEL_DAYS, escalations, holds, levelCounts } from './model';
import type { EscalationRow, Level } from './model';

/**
 * AUD-11: the recommendations that are near their day or past it (ST-AUD-006, AUD 3.3, BR-AUD-06): reminded 7, 3 and 1 days before the day, and once the day has passed the unit leader of the owner is told through NOT. The
 * level is told in words, not by colour alone. What is shown is where each recommendation stands against its day; the delivery of a notice is kept by NOT and is not read here.
 */
export default function EscalationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What is listed belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <EscalationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EscalationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.escalation.page.title')}</h1>
          <p>{t('aud.escalation.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="confidential-note">
        {t('aud.remediation.confidential.note')}
      </p>
      {holds(permissions, READ_PERMISSION) ? (
        <EscalationList />
      ) : (
        <div data-testid="escalation-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('aud.followup.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EscalationList() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const engagementId = params.get('engagement') ?? undefined;
  const [level, setLevel] = useState<'' | Level>('');
  const list = useRecommendationBoard({ engagementId, status: '', type: '' });
  const today = todayInVietnam();
  const watched = escalations(list.data ?? [], today);
  const rows = level === '' ? watched : watched.filter((row) => row.level === level);
  const counts = levelCounts(watched);
  // Nothing to watch at all is the empty list; a level that has none is told inside the table.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : watched });
  return (
    <>
      <div className="card aud-filters">
        <EngagementFilter selected={engagementId} />
        <Field id="escalation-level" label={t('aud.escalation.filter.level')} error={undefined}>
          <select id="escalation-level" value={level} onChange={(event) => setLevel(event.target.value as '' | Level)}>
            <option value="">{t('aud.escalation.filter.all')}</option>
            {LEVELS.map((entry) => (
              <option key={entry} value={entry}>
                {levelLabel(t, entry)}
              </option>
            ))}
          </select>
        </Field>
        <p className="sub">
          <Link to={BOARD_PATH + (engagementId === undefined ? '' : `?engagement=${engagementId}`)}>{t('aud.followup.board.link')}</Link>
        </p>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <ul className="aud-cards" data-testid="escalation-counts">
          {LEVELS.map((entry) => (
            <li key={entry} className="card" data-level={entry}>
              <strong>{counts[entry]}</strong> <span className="sub">{levelLabel(t, entry)}</span>
            </li>
          ))}
        </ul>
        <p className="sub" data-testid="escalation-rule">
          {t('aud.escalation.rule.note', { days: SECOND_LEVEL_DAYS })}
        </p>
        <div className="tablewrap">
          <table className="table" data-testid="escalation-table" aria-label={t('aud.escalation.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('aud.escalation.column.recommendation')}</th>
                <th scope="col">{t('aud.escalation.column.owner')}</th>
                <th scope="col">{t('aud.escalation.column.due')}</th>
                <th scope="col">{t('aud.escalation.column.late')}</th>
                <th scope="col">{t('aud.escalation.column.level')}</th>
                <th scope="col">{t('aud.escalation.column.reminders')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.item.id} row={row} today={today} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? <p data-testid="escalation-none">{t('aud.escalation.none.notice')}</p> : null}
      </StateBoundary>
    </>
  );
}

function Row({ row, today }: { row: EscalationRow; today: string }) {
  const { t } = useTranslation();
  const { item } = row;
  return (
    <tr data-recommendation-id={item.id} data-level={row.level}>
      <td>
        <strong>{item.code}</strong> <span className="sub">{item.engagement.code}</span>
      </td>
      <td>{item.ownerUser !== null ? item.ownerUser.name : item.ownerUnit !== null ? item.ownerUnit.name : t('aud.remediation.owner.none')}</td>
      <td>
        <DueDay item={item} today={today} />
      </td>
      <td>{row.lateDays > 0 ? row.lateDays : t('aud.escalation.late.left', { days: row.daysLeft })}</td>
      <td>
        <span className="aud-badge warning">{levelLabel(t, row.level)}</span>
      </td>
      <td>{row.reminders.length === 0 ? '—' : row.reminders.map((day) => t('aud.escalation.reminder.day', { days: day })).join(', ')}</td>
    </tr>
  );
}
