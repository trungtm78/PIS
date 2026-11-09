import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StatusPill } from '../../../ui';
import { Frame, UnverifiedNote, asList, num, text, useGovRead } from '../../gov11/gov11-kit';
import type { RuleReading } from '../../gov11/gov11-kit';
import { STEP_KINDS, isStepKind, scheduleKeyOf, stepKeyOf } from './model';

/** The screen where a new version of the rules is proposed, approved by someone other than who proposed it (ADM-19, the repository of governance rules). */
const RULES_PATH = '/adm/adm-19';

/**
 * ADM-31, the deadline of each step of the reporting calendar (QT.02): for each kind of period the rule `REPORTING_SCHEDULE` in force, the days and hour of every step, the reminders and the escalation, the version
 * that decides and whether it is the built-in default nobody confirmed. A new version is proposed, submitted and approved in the repository of governance rules (the approver is not the proposer); this screen shows
 * what is in force and leads there.
 */
export default function ScheduleRulesScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const year = String(new Date().getFullYear());
  const query = useGovRead('dis', 'getReportingCalendar', { query: { year } });
  const schedules = asList(query.data?.schedules);
  return (
    <Frame
      route={route}
      title={t('ent4c.schedule.title')}
      subtitle={t('ent4c.schedule.subtitle')}
      scope={[{ label: t('ent4c.common.scope'), value: tenant?.name ?? '–' }]}
      query={query}
      isEmpty={() => schedules.length === 0}
      notice={<UnverifiedNote rules={schedules.map((one) => one as unknown as RuleReading)} />}
    >
      {() => (
        <div className="gov11-grid">
          <p>
            <Link to={RULES_PATH} className="ui-button ui-button--outline" data-testid="propose-link">
              {t('ent4c.schedule.propose')}
            </Link>
          </p>
          <div className="gov11-scroll">
            <table className="gov11-table" data-testid="schedule-table">
              <caption>{t('ent4c.schedule.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('ent4c.schedule.col.code')}</th>
                  {STEP_KINDS.map((step) => (
                    <th key={step} scope="col">
                      {t(`ent4c.step.${stepKeyOf(step)}`)}
                    </th>
                  ))}
                  <th scope="col">{t('ent4c.schedule.col.reminders')}</th>
                  <th scope="col">{t('ent4c.schedule.col.version')}</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((one) => {
                  const steps = asList(one.steps);
                  const before = Array.isArray(one.reminder_days_before) ? (one.reminder_days_before as unknown[]).map((day) => num(day)) : [];
                  return (
                    <tr key={text(one.code)} data-testid="schedule-row" data-code={text(one.code)}>
                      <th scope="row">{t(`ent4c.schedule.code.${scheduleKeyOf(text(one.code))}`)}</th>
                      {STEP_KINDS.map((step) => {
                        const found = steps.find((s) => isStepKind(s.kind) && s.kind === step);
                        return <td key={step}>{found === undefined ? '–' : found.time === null || found.time === undefined ? t('ent4c.schedule.offset', { days: num(found.offset_days) }) : t('ent4c.schedule.offsetAt', { days: num(found.offset_days), time: text(found.time) })}</td>;
                      })}
                      <td>
                        {before.length === 0 ? t('ent4c.schedule.reminders.none') : t('ent4c.schedule.reminders.before', { days: before.join(', ') })}
                        <br />
                        {num(one.overdue_max_reminders) === 0 ? t('ent4c.schedule.overdue.none') : t('ent4c.schedule.overdue.repeat', { every: num(one.overdue_repeat_days), max: num(one.overdue_max_reminders) })}
                        <br />
                        {num(one.escalate_after_overdue_days) === 0 ? t('ent4c.schedule.escalate.never') : t('ent4c.schedule.escalate.after', { days: num(one.escalate_after_overdue_days) })}
                      </td>
                      <td>
                        {one.source === 'RULE' ? t('ent4c.schedule.version.rule', { version: num(one.version) }) : t('ent4c.schedule.version.default')}{' '}
                        {one.unverified === true ? <StatusPill tone="warning">{t('ent4c.schedule.unverified')}</StatusPill> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Frame>
  );
}
