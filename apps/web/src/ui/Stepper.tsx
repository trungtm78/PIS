import { useTranslation } from '../i18n';
import type { Translator } from '../i18n';
import { toneClass } from './types';
import type { Tone } from './types';

/** `started`: work has begun on the step in parallel while the thing is still at an earlier step (it is never the step the thing is at). */
export type StepperStatus = 'done' | 'current' | 'started' | 'upcoming' | 'skipped' | 'hold' | 'late';

export interface StepperStep {
  code: string;
  label: string;
  status: StepperStatus;
  /** The days the standard gives the step and the days it took (or has taken so far). */
  plannedDays?: number | undefined;
  actualDays?: number | undefined;
  /** How many days past the standard a late step is. */
  lateDays?: number | undefined;
  /** The step the thing is at when its status says more than "current" (late, on hold). */
  current?: boolean | undefined;
  /** Why a step was skipped, shown as text under the label. */
  note?: string | undefined;
}

export interface StepperProps {
  steps: readonly StepperStep[];
  /** The name of the list for screen readers. */
  label: string;
}

const ICON: Readonly<Record<StepperStatus, string>> = { done: '✓', current: '●', started: '◔', upcoming: '', skipped: '⤼', hold: '⏸', late: '⛔' };
const TONE: Readonly<Record<StepperStatus, Tone>> = { done: 'success', current: 'default', started: 'info', upcoming: 'neutral', skipped: 'neutral', hold: 'neutral', late: 'danger' };

function word(t: Translator['t'], status: StepperStatus): string {
  switch (status) {
    case 'done':
      return t('ui.stepper.status.done');
    case 'current':
      return t('ui.stepper.status.current');
    case 'started':
      return t('ui.stepper.status.started');
    case 'upcoming':
      return t('ui.stepper.status.upcoming');
    case 'skipped':
      return t('ui.stepper.status.skipped');
    case 'hold':
      return t('ui.stepper.status.hold');
    case 'late':
      return t('ui.stepper.status.late');
  }
}

/**
 * The steps of a process in order (docs/process-tree-design.md section 7.1): horizontal from 980 px (wrapping into rows rather than scrolling), vertical below. Each step has a number or an icon, a name, a status word and, under it,
 * the days the standard gives it against the days it took. The step the thing is at is `aria-current="step"` and is the only one with a filled primary circle; a late step says by how many days.
 */
export function Stepper({ steps, label }: StepperProps) {
  const { t } = useTranslation();
  return (
    <ol className="ui-stepper" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.code} className={`ui-stepper__step ui-stepper__step--${step.status} ${toneClass(TONE[step.status])}`} aria-current={step.status === 'current' || step.current === true ? 'step' : undefined} data-step={step.code}>
          <span className="ui-stepper__circle" aria-hidden="true">
            {ICON[step.status] === '' ? index + 1 : ICON[step.status]}
          </span>
          <span className="ui-stepper__text">
            <span className={`ui-stepper__label${step.status === 'skipped' ? ' is-skipped' : ''}`}>{step.label}</span>
            <span className="ui-stepper__status">{step.status === 'late' && step.lateDays !== undefined ? t('ui.stepper.status.lateDays', { days: step.lateDays }) : word(t, step.status)}</span>
            {(step.plannedDays !== undefined || step.actualDays !== undefined) && (
              <span className="ui-stepper__days">
                {step.plannedDays !== undefined && t('ui.stepper.days.planned', { days: step.plannedDays })}
                {step.plannedDays !== undefined && step.actualDays !== undefined && ' · '}
                {step.actualDays !== undefined && t('ui.stepper.days.actual', { days: step.actualDays })}
              </span>
            )}
            {step.note !== undefined && <span className="ui-stepper__note">{step.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
