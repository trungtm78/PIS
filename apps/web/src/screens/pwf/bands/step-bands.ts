import { readTemplate, stepsOf } from '../templates/template-model';

/** The thresholds a template carries on its own steps (R59): the exceptions the policy page lists read-only, so an administrator sees every one of them. */
export interface StepBand {
  /** The code of the template in the rule store. */
  template: string;
  templateName: string;
  phase: string;
  step: string;
  /** Red, yellow, green as written in the template; null for a number the template leaves out. */
  red: number | null;
  yellow: number | null;
  green: number | null;
}

const num = (value: number | undefined): number | null => (typeof value === 'number' ? value : null);

/** The steps of one template that carry thresholds of their own, in the order of the template. */
export function stepBandsOf(code: string, params: unknown): StepBand[] {
  const template = readTemplate(params);
  const phaseName = (phase: string): string => template.phases.find((one) => one.code === phase)?.name || phase;
  const stepName = (stepCode: string | null | undefined, taskName: string): string => {
    const step = stepCode === null || stepCode === undefined ? undefined : stepsOf(template).find((one) => one.code === stepCode);
    return step === undefined || step.name === '' || step.name === taskName ? taskName : `${step.name} · ${taskName}`;
  };
  return template.tasks.flatMap((task): StepBand[] => {
    const bands = task.bands;
    if (bands === undefined || Object.keys(bands).length === 0) return [];
    return [{ template: code, templateName: template.name, phase: phaseName(task.phase), step: stepName(task.step, task.name), red: num(bands.red_days), yellow: num(bands.yellow_days), green: num(bands.green_days) }];
  });
}
