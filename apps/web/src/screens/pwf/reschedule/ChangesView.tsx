import { useTranslation } from '../../../i18n';
import { ScrollRegion } from '../../scroll-region';
import { SectionCard, StatusPill } from '../../../ui';
import { CalendarMissingCell, CalendarMissingNote, FigureInfo } from '../components';
import { dayText, missingYears } from '../model';
import type { ReschedulePreview, Schedule } from '../model';
import { extensionUnitWord } from '../task-cells';
import { changeRows, groupChanges, shiftText, summarizeChanges } from './model';
import type { ChangeGroup, ChangeRow } from './model';

const range = (from: string | null, to: string | null): string => (from === null && to === null ? '–' : `${dayText(from)} – ${dayText(to)}`);

function CriticalMark({ row }: { row: ChangeRow }) {
  const { t } = useTranslation();
  if (row.becameCritical) {
    return (
      <StatusPill tone="danger" icon="⛔">
        {t('pwf.resched.critical.became.word')}
      </StatusPill>
    );
  }
  if (row.becameNonCritical) {
    return (
      <StatusPill tone="success" icon="✓">
        {t('pwf.resched.critical.left.word')}
      </StatusPill>
    );
  }
  return <span>{t('pwf.resched.critical.same.word')}</span>;
}

function groupWord(t: ReturnType<typeof useTranslation>['t'], group: ChangeGroup): { title: string; note: string } {
  switch (group) {
    case 'EXTENDED':
      return { title: t('pwfp.resched.group.extended.title'), note: t('pwfp.resched.group.extended.note') };
    case 'CASCADED':
      return { title: t('pwfp.resched.group.cascaded.title'), note: t('pwfp.resched.group.cascaded.note') };
    case 'OTHER':
      return { title: t('pwfp.resched.group.other.title'), note: t('pwfp.resched.group.other.note') };
  }
}

export interface ChangesViewProps {
  preview: ReschedulePreview;
  before: Schedule | undefined;
}

/** The before and after of a proposal in working days: what moves and by how much, the float and the critical path, and the variance against the FIRST baseline, which a reschedule never changes (BR-PWF-07, BR-PWF-08). */
/** A shift in working days in words: "5 days earlier", "3 days later", "unchanged" (a signed number alone does not say which way is good). */
function shiftWords(t: ReturnType<typeof useTranslation>['t'], days: number | null): string {
  if (days === null) return '';
  if (days === 0) return t('pwf6.resched.shift.none');
  return days < 0 ? t('pwf6.resched.shift.earlier', { days: Math.abs(days) }) : t('pwf6.resched.shift.later', { days });
}

export function ChangesView({ preview, before }: ChangesViewProps) {
  const { t } = useTranslation();
  const rows = changeRows(preview, before);
  const summary = summarizeChanges(preview);
  const asked = preview.extensions ?? [];
  const names = new Map(preview.schedule.tasks.map((task) => [task.task_code, task.name]));
  const version = t('pwf.resched.info.version.text', { base: preview.base_version, hash: preview.result_hash.slice(0, 8) });
  const info = (name: string, formula: string, source: string) => <FigureInfo name={name} formula={formula} source={source} asOf={preview.as_of} version={version} />;
  return (
    <SectionCard title={t('pwf.resched.result.title')}>
      <div data-testid="proposal">
        <dl className="pwf-facts">
          <dt>{t('pwf.resched.result.finishShift.label')}</dt>
          <dd data-testid="finish-shift">
            <span className="pwf-figure">
              {t('pwf.resched.result.shiftDays.text', { shift: shiftText(preview.project_finish_shift_days) })}
              {info(t('pwf.resched.result.finishShift.label'), t('pwf.resched.info.shift.formula'), t('pwf.resched.info.shift.source'))}
            </span>
          </dd>
          <dt>{t('pwf.resched.result.projectFinish.label')}</dt>
          <dd>
            {dayText(before?.project_finish)} → {dayText(preview.schedule.project_finish)}
          </dd>
          <dt>{t('pwf.resched.result.summary.label')}</dt>
          <dd data-testid="summary">{t('pwf.resched.result.summary.text', { total: summary.total, slipped: summary.slipped, gained: summary.gained, became: summary.becameCritical, left: summary.becameNonCritical })}</dd>
          {summary.extended + summary.cascaded === 0 ? null : (
            <>
              <dt>{t('pwfp.resched.result.causes.label')}</dt>
              <dd data-testid="causes">{t('pwfp.resched.result.causes.text', { extended: summary.extended, cascaded: summary.cascaded })}</dd>
            </>
          )}
          {asked.length === 0 ? null : (
            <>
              <dt>{t('pwfp.resched.result.asked.label')}</dt>
              <dd>
                <ul className="pwf-list" data-testid="extensions-asked">
                  {asked.map((line) => (
                    <li key={line.task_code} data-extension={line.task_code}>
                      {t('pwfp.resched.result.asked.line', { task: names.get(line.task_code) ?? line.task_code, value: line.add_value, unit: extensionUnitWord(t, line.unit) })}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
        <p className="callout" data-testid="baseline-note">
          {t('pwf.resched.baseline.note')}
        </p>
        <CalendarMissingNote years={missingYears(preview.schedule.tasks)} />
        {rows.length === 0 ? (
          <p className="callout" role="status" data-testid="no-changes">
            {t('pwf.resched.result.empty.notice')}
          </p>
        ) : (
          <div className="pwf-free">
          <ScrollRegion label={t('pwf.resched.result.table.caption')}>
          <table className="pwf-outline pwf-outline--flat pwf-resched">
            <caption className="ui-sr-only">{t('pwf.resched.result.table.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('pwf.resched.col.task')}</th>
                <th scope="col">{t('pwf.resched.col.before')}</th>
                <th scope="col">{t('pwf.resched.col.after')}</th>
                <th scope="col">
                  {t('pwf.resched.col.shift')} {info(t('pwf.resched.col.shift'), t('pwf.resched.info.shift.formula'), t('pwf.resched.info.shift.source'))}
                </th>
                <th scope="col">
                  {t('pwf.resched.col.float')} {info(t('pwf.resched.col.float'), t('pwf.resched.info.float.formula'), t('pwf.resched.info.float.source'))}
                </th>
                <th scope="col">{t('pwf.resched.col.critical')}</th>
                <th scope="col">
                  {t('pwf.resched.col.variance')} {info(t('pwf.resched.col.variance'), t('pwf.resched.info.variance.formula'), t('pwf.resched.info.variance.source'))}
                </th>
              </tr>
            </thead>
            {groupChanges(rows).map(({ group, rows: inGroup }) => (
              <tbody key={group} data-group={group} data-testid={`group-${group}`}>
                <tr className="pwf-resched__group">
                  <th scope="rowgroup" colSpan={7}>
                    <strong>{groupWord(t, group).title}</strong> <span className="pwf-hint">{groupWord(t, group).note}</span>
                  </th>
                </tr>
                {inGroup.map((row) => (
                <tr key={row.code} data-testid={`change-${row.code}`}>
                  <th scope="row">
                    <span className="pwf-cellstack">
                      <span>{row.name}</span>
                      <span className="pwf-code">{row.code}</span>
                    </span>
                  </th>
                  <td>{range(row.beforeStart, row.beforeFinish)}</td>
                  <td>{row.calendarMissingYear === null ? range(row.afterStart, row.afterFinish) : <CalendarMissingCell year={row.calendarMissingYear} />}</td>
                  <td>
                    {row.startShift === row.finishShift ? shiftWords(t, row.finishShift) : t('pwf6.resched.shift.pair', { start: shiftWords(t, row.startShift), finish: shiftWords(t, row.finishShift) })}
                    {row.finishShift === 0 && row.finishCalendarShift !== null && row.finishCalendarShift !== 0 ? (
                      <span className="pwf-hint" data-testid={`calendar-shift-${row.code}`}>
                        {row.finishCalendarShift > 0 ? t('pwfp.resched.shift.calendar.later', { days: row.finishCalendarShift }) : t('pwfp.resched.shift.calendar.earlier', { days: Math.abs(row.finishCalendarShift) })}
                      </span>
                    ) : null}
                  </td>
                  <td>{shiftText(row.floatChange)}</td>
                  <td>
                    <CriticalMark row={row} />
                  </td>
                  <td>{row.baselineFinishVariance === null ? '' : shiftWords(t, row.baselineFinishVariance)}</td>
                </tr>
                ))}
              </tbody>
            ))}
          </table>
          </ScrollRegion>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
