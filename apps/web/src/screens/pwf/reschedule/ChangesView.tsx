import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { CalendarMissingCell, CalendarMissingNote, FigureInfo } from '../components';
import { dayText, missingYears } from '../model';
import type { ReschedulePreview, Schedule } from '../model';
import { changeRows, shiftText, summarizeChanges } from './model';
import type { ChangeRow } from './model';

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

export interface ChangesViewProps {
  preview: ReschedulePreview;
  before: Schedule | undefined;
}

/** The before and after of a proposal in working days: what moves and by how much, the float and the critical path, and the variance against the FIRST baseline, which a reschedule never changes (BR-PWF-07, BR-PWF-08). */
export function ChangesView({ preview, before }: ChangesViewProps) {
  const { t } = useTranslation();
  const rows = changeRows(preview, before);
  const summary = summarizeChanges(preview);
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
          <table className="pwf-table">
            <caption>{t('pwf.resched.result.table.caption')}</caption>
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
            <tbody>
              {rows.map((row) => (
                <tr key={row.code} data-testid={`change-${row.code}`}>
                  <td>
                    <code>{row.code}</code> {row.name}
                  </td>
                  <td>{range(row.beforeStart, row.beforeFinish)}</td>
                  <td>{row.calendarMissingYear === null ? range(row.afterStart, row.afterFinish) : <CalendarMissingCell year={row.calendarMissingYear} />}</td>
                  <td>{t('pwf.resched.col.shiftPair.text', { start: shiftText(row.startShift), finish: shiftText(row.finishShift) })}</td>
                  <td>{shiftText(row.floatChange)}</td>
                  <td>
                    <CriticalMark row={row} />
                  </td>
                  <td>{row.baselineFinishVariance === null ? '–' : t('pwf.resched.col.variance.text', { days: shiftText(row.baselineFinishVariance) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SectionCard>
  );
}
