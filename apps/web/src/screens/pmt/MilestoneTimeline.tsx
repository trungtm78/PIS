import { useTranslation } from '../../i18n';
import { SectionCard } from '../../ui';
import { stepLabel } from './dossier-labels';
import type { MilestoneView } from './dossier-model';
import './pmt.css';

/** The milestones of a permit in the order they were recorded: a step that happened is marked by its day, one that is only planned by the day it is planned for. */
export function MilestoneTimeline({ milestones }: { milestones: readonly MilestoneView[] }) {
  const { t } = useTranslation();
  return (
    <div data-testid="timeline">
      <SectionCard title={t('pmt.permit.timeline.title')}>
      {milestones.length === 0 ? (
        <p className="sub" data-testid="no-milestones">
          {t('pmt.permit.timeline.empty.text')}
        </p>
      ) : (
        <ol className="pmt-timeline" aria-label={t('pmt.permit.timeline.aria')}>
          {milestones.map((milestone) => (
            <li key={milestone.id} className={milestone.actualOn === null ? undefined : 'done'} data-step={milestone.stepCode}>
              <strong>{stepLabel(t, milestone.stepCode)}</strong>
              <br />
              <span className="sub">
                {milestone.actualOn === null
                  ? t('pmt.permit.timeline.planned.text', { date: milestone.plannedOn ?? '' })
                  : t('pmt.permit.timeline.actual.text', { date: milestone.actualOn })}
              </span>
              {milestone.note === null ? null : <p>{milestone.note}</p>}
              {milestone.documentVersionId === null ? null : <p className="sub">{t('pmt.permit.timeline.scan.text')}</p>}
            </li>
          ))}
        </ol>
      )}
      </SectionCard>
    </div>
  );
}
