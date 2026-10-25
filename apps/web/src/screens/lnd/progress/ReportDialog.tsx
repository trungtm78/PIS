import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import type { SectionOption, UnitOption } from '../model';
import { executorKindLabel, fieldProblemMessage, problemMessage, stageLabel } from './labels';
import { useReportStage } from './hooks';
import { EMPTY_FORM, EXECUTOR_KINDS, STAGE_CODES, describeProblem, formOf, reportBody, validateReport } from './model';
import type { ExecutorKind, ReportForm, StageCode, StageLine } from './model';

export interface ReportDialogProps {
  projectId: string;
  today: string;
  sections: readonly SectionOption[];
  units: readonly UnitOption[];
  /** The stage being corrected; undefined for a stage the people of the project give to an executor with its first report. */
  stage: StageLine | undefined;
  onClose(): void;
}

/**
 * The report of a stage that is tracked from outside (LND-11): the executing unit says how many parcels are done and backs the figure with a document the scan found
 * clean. A stage that is already reported keeps its section and its stage, and the form starts from what was reported.
 */
export function ReportDialog({ projectId, today, sections, units, stage, onClose }: ReportDialogProps) {
  const { t } = useTranslation();
  const report = useReportStage();
  const [form, setForm] = useState<ReportForm>(stage === undefined ? EMPTY_FORM : formOf(stage));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateReport(form, today);
  const error = (field: keyof ReportForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? fieldProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (report.isPending || Object.keys(problems).length > 0) return;
    report.mutate(reportBody(projectId, form), { onSuccess: onClose });
  };
  const text = (field: keyof ReportForm) => ({ value: form[field], onChange: (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value }) });
  const fixed = stage !== undefined;
  return (
    <DialogFrame
      title={stage === undefined ? t('lnd.progress.dialog.create') : t('lnd.progress.dialog.update', { stage: stageLabel(t, stage.stageCode) })}
      onClose={onClose}
      refusal={report.isError ? problemMessage(t, describeProblem(report.error)) : undefined}
      pending={report.isPending}
      onSubmit={submit}
    >
      <Field id="stage-section" label={t('lnd.progress.field.section')} error={error('sectionId')}>
        <select id="stage-section" disabled={fixed} {...text('sectionId')}>
          <option value="">{t('lnd.progress.field.choose')}</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.code}
            </option>
          ))}
        </select>
      </Field>
      <Field id="stage-code" label={t('lnd.progress.field.stage')} error={error('stageCode')}>
        <select id="stage-code" disabled={fixed} value={form.stageCode} onChange={(event) => setForm({ ...form, stageCode: event.target.value as StageCode | '' })}>
          <option value="">{t('lnd.progress.field.choose')}</option>
          {STAGE_CODES.map((code) => (
            <option key={code} value={code}>
              {stageLabel(t, code)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="stage-kind" label={t('lnd.progress.field.executorKind')} error={error('executorKind')}>
        <select id="stage-kind" value={form.executorKind} onChange={(event) => setForm({ ...form, executorKind: event.target.value as ExecutorKind | '' })}>
          <option value="">{t('lnd.progress.field.choose')}</option>
          {EXECUTOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {executorKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="stage-unit" label={t('lnd.progress.field.executorUnit')} error={error('executorUnitId')}>
        <select id="stage-unit" {...text('executorUnitId')}>
          <option value="">{t('lnd.progress.field.choose')}</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="stage-total" label={t('lnd.progress.field.parcelsTotal')} error={error('parcelsTotal')}>
        <input id="stage-total" inputMode="numeric" {...text('parcelsTotal')} />
      </Field>
      <Field id="stage-done" label={t('lnd.progress.field.parcelsDone')} error={error('parcelsDone')}>
        <input id="stage-done" inputMode="numeric" {...text('parcelsDone')} />
      </Field>
      <Field id="stage-planned-start" label={t('lnd.progress.field.plannedStart')} error={error('plannedStart')}>
        <input id="stage-planned-start" type="date" {...text('plannedStart')} />
      </Field>
      <Field id="stage-planned-end" label={t('lnd.progress.field.plannedEnd')} error={error('plannedEnd')}>
        <input id="stage-planned-end" type="date" {...text('plannedEnd')} />
      </Field>
      <Field id="stage-actual-start" label={t('lnd.progress.field.actualStart')} error={error('actualStart')}>
        <input id="stage-actual-start" type="date" max={today} {...text('actualStart')} />
      </Field>
      <Field id="stage-actual-end" label={t('lnd.progress.field.actualEnd')} error={error('actualEnd')} hint={t('lnd.progress.field.actualEndHelp')}>
        <input id="stage-actual-end" type="date" max={today} {...text('actualEnd')} />
      </Field>
      <Field id="stage-evidence" label={t('lnd.progress.field.evidence')} error={error('evidenceId')} hint={t('lnd.progress.field.evidenceHelp')}>
        <input id="stage-evidence" {...text('evidenceId')} />
      </Field>
      <Field id="stage-note" label={t('lnd.progress.field.blocker')} error={error('blockerNote')} hint={t('lnd.progress.field.blockerHelp')}>
        <textarea id="stage-note" rows={3} {...text('blockerNote')} />
      </Field>
    </DialogFrame>
  );
}
