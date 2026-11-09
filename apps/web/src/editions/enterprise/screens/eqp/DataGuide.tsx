import { useTranslation } from '../../../../i18n';
import { SectionCard, StatusPill } from '../../../../ui';
import type { Guide } from './model';

const TONE = { NEVER_IMPORTED: 'warning', FRESH: 'success', AGING: 'warning', STALE: 'danger' } as const;

/**
 * "How to get data": the state of the file import of the national bidding network that feeds the packages, and the steps to follow. The platform opens no connection to the network, a person downloads the files and hands them over;
 * while the layout of the file is a working assumption the result is PENDING-EXTERNAL and cannot be accepted (eng-review R18).
 */
export function DataGuide({ guide }: { guide: Guide }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('eqp.guide.title')} status={<StatusPill tone={TONE[guide.state]}>{t(`eqp.guide.state.${guide.state}`)}</StatusPill>}>
      <div data-testid="data-guide" data-state={guide.state}>
        <p className="ent2-note">
          {guide.ageHours === null ? t('eqp.guide.never') : t('eqp.guide.age', { hours: Math.round(guide.ageHours) })} {t('eqp.guide.layout', { layout: guide.layoutVersion })}
        </p>
        {guide.acceptance === 'PENDING_EXTERNAL' ? (
          <p className="callout warning" data-testid="pending-external">
            {t('eqp.guide.pending')}
          </p>
        ) : null}
        <ol>
          {guide.steps.map((step) => (
            <li key={step}>{t(`eqp.guide.step.${step}`)}</li>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}
