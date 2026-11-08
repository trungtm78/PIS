import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog, MakerCheckerBadge } from '../../../ui';
import { dayText, vietnamToday } from '../../gov3/model';
import { FormField } from './components';
import { useDecideAssessment, useFixTargets, useGenerateCalendar, useRecordMeasurement, useSaveDraft, useSubmitAssessment } from './hooks';
import { anchorText, conclusionText, directionText, kindText, problemText, refusalText } from './labels';
import {
  ASSESSMENT_KINDS,
  CONCLUSIONS,
  DIRECTIONS,
  EMPTY_INDICATOR,
  EMPTY_MEASURE,
  MAX_INDICATORS,
  MIN_RETURN_REASON,
  assessBody,
  decisionBody,
  describeRefusal,
  draftBody,
  draftFormOf,
  hasProblems,
  measureBody,
  personName,
  validateAssess,
  validateDraft,
  validateMeasure,
} from './model';
import type { AssessForm, Assessment, AssessmentKind, CalendarResult, Conclusion, DraftForm, DraftProblems, EffectView, FormProblem, IndicatorField, IndicatorForm, MeasureField, MeasureForm, Measurement, TargetSet } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export interface DialogProps {
  view: EffectView;
  onClose: () => void;
  /** The words said on the screen once the command went through. */
  onDone: (message: string) => void;
}

const firstOf = (problems: Partial<Record<string, FormProblem>>): string | undefined => Object.keys(problems).find((key) => problems[key] !== undefined);

// ---- the draft of the targets ---------------------------------------------------------------------------------------------------

function indicatorFieldText(t: Translate, field: IndicatorField): string {
  switch (field) {
    case 'code':
      return t('mr1.effect.form.code');
    case 'name':
      return t('mr1.effect.form.name');
    case 'unit':
      return t('mr1.effect.form.unit');
    case 'direction':
      return t('mr1.effect.form.direction');
    case 'baselineValue':
      return t('mr1.effect.form.baselineValue');
    case 'baselineOn':
      return t('mr1.effect.form.baselineOn');
    case 'targetValue':
      return t('mr1.effect.form.targetValue');
    case 'measureAfterMonths':
      return t('mr1.effect.form.measureAfter');
    case 'dataSource':
      return t('mr1.effect.form.dataSource');
    case 'formula':
      return t('mr1.effect.form.formula');
  }
}

/** The draft of the target indicators: the basis, an optional document, the reason of a revision when a fixed set stands, and one block per indicator that can be added and removed. */
export function DraftDialog({ view, onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const save = useSaveDraft();
  const needsReason = view.fixed !== null;
  const [form, setForm] = useState<DraftForm>(() => draftFormOf(view.draft ?? view.fixed));
  const [problems, setProblems] = useState<DraftProblems>({ rows: [] });
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const set = (patch: Partial<DraftForm>): void => setForm((current) => ({ ...current, ...patch }));
  const setRow = (index: number, patch: Partial<IndicatorForm>): void => setForm((current) => ({ ...current, indicators: current.indicators.map((row, at) => (at === index ? { ...row, ...patch } : row)) }));
  const rowProblem = (index: number, field: IndicatorField): string | undefined => {
    const found = problems.rows[index]?.[field];
    return found === undefined ? undefined : problemText(t, found);
  };
  const top = (field: 'basis' | 'basisDocumentId' | 'supersedeReason'): string | undefined => (problems[field] === undefined ? undefined : problemText(t, problems[field]));

  const confirm = (reason?: string): void => {
    const next: DraftForm = { ...form, supersedeReason: reason ?? form.supersedeReason };
    const found = validateDraft(next, needsReason);
    setProblems(found);
    if (hasProblems(found)) {
      const rowAt = found.rows.findIndex((row) => Object.keys(row).length > 0);
      const rowField = rowAt < 0 ? undefined : firstOf(found.rows[rowAt] ?? {});
      const field =
        found.basis !== undefined
          ? t('mr1.effect.form.basis')
          : found.basisDocumentId !== undefined
            ? t('mr1.effect.form.basisDocument')
            : found.supersedeReason !== undefined
              ? t('mr1.effect.form.supersedeReason')
              : found.indicators !== undefined
                ? t('mr1.effect.form.indicators')
                : rowField === undefined
                  ? ''
                  : t('mr1.effect.form.rowField', { row: rowAt + 1, field: indicatorFieldText(t, rowField as IndicatorField) });
      setRefusal(t('mr1.effect.validation.field', { field }));
      return;
    }
    setRefusal(undefined);
    save.mutate(
      { projectId: view.project.id, body: draftBody(next, needsReason) },
      {
        onSuccess: () => {
          onDone(t('mr1.effect.draft.done'));
          onClose();
        },
        onError: (error) => setRefusal(refusalText(t, describeRefusal(error))),
      },
    );
  };

  return (
    <ConfirmDialog
      open
      title={needsReason ? t('mr1.effect.draft.titleRevision') : t('mr1.effect.draft.title')}
      context={[
        { label: t('mr1.effect.ctx.project'), value: view.project.code },
        { label: t('mr1.effect.draft.effect'), value: needsReason ? t('mr1.effect.draft.effect.revision') : t('mr1.effect.draft.effect.new') },
      ]}
      confirmLabel={t('mr1.effect.draft.confirm')}
      cancelLabel={t('mr1.effect.common.cancel')}
      pending={save.isPending}
      {...(needsReason ? { reason: { label: t('mr1.effect.form.supersedeReason'), required: true, minLength: 10, hint: t('mr1.effect.form.supersedeReason.hint') } } : {})}
      {...(refusal === undefined ? {} : { error: refusal })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="eff-form" data-testid="draft-form">
        <FormField id="draft-basis" label={t('mr1.effect.form.basis')} error={top('basis')} hint={t('mr1.effect.form.basis.hint')}>
          <input type="text" value={form.basis} onChange={(event) => set({ basis: event.target.value })} />
        </FormField>
        <FormField id="draft-basis-doc" label={t('mr1.effect.form.basisDocument')} error={top('basisDocumentId')} hint={t('mr1.effect.form.optional')}>
          <input type="text" value={form.basisDocumentId} onChange={(event) => set({ basisDocumentId: event.target.value })} />
        </FormField>
        {form.indicators.map((row, index) => (
          <fieldset className="eff-indicator" key={index} data-indicator-row={index}>
            <legend>{t('mr1.effect.form.indicator', { row: index + 1 })}</legend>
            <FormField id={`draft-${index}-code`} label={t('mr1.effect.form.code')} error={rowProblem(index, 'code')} hint={t('mr1.effect.form.code.hint')}>
              <input type="text" value={row.code} onChange={(event) => setRow(index, { code: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-name`} label={t('mr1.effect.form.name')} error={rowProblem(index, 'name')}>
              <input type="text" value={row.name} onChange={(event) => setRow(index, { name: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-unit`} label={t('mr1.effect.form.unit')} error={rowProblem(index, 'unit')}>
              <input type="text" value={row.unit} onChange={(event) => setRow(index, { unit: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-direction`} label={t('mr1.effect.form.direction')} error={undefined}>
              <select value={row.direction} onChange={(event) => setRow(index, { direction: event.target.value === 'LOWER_IS_BETTER' ? 'LOWER_IS_BETTER' : 'HIGHER_IS_BETTER' })}>
                {DIRECTIONS.map((value) => (
                  <option key={value} value={value}>
                    {directionText(t, value)}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id={`draft-${index}-baseline`} label={t('mr1.effect.form.baselineValue')} error={rowProblem(index, 'baselineValue')} hint={t('mr1.effect.form.decimal.hint')}>
              <input type="text" inputMode="decimal" value={row.baselineValue} onChange={(event) => setRow(index, { baselineValue: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-baseline-on`} label={t('mr1.effect.form.baselineOn')} error={rowProblem(index, 'baselineOn')}>
              <input type="date" value={row.baselineOn} onChange={(event) => setRow(index, { baselineOn: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-target`} label={t('mr1.effect.form.targetValue')} error={rowProblem(index, 'targetValue')} hint={t('mr1.effect.form.decimal.hint')}>
              <input type="text" inputMode="decimal" value={row.targetValue} onChange={(event) => setRow(index, { targetValue: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-after`} label={t('mr1.effect.form.measureAfter')} error={rowProblem(index, 'measureAfterMonths')} hint={t('mr1.effect.form.measureAfter.hint')}>
              <input type="text" inputMode="numeric" value={row.measureAfterMonths} onChange={(event) => setRow(index, { measureAfterMonths: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-source`} label={t('mr1.effect.form.dataSource')} error={rowProblem(index, 'dataSource')}>
              <input type="text" value={row.dataSource} onChange={(event) => setRow(index, { dataSource: event.target.value })} />
            </FormField>
            <FormField id={`draft-${index}-formula`} label={t('mr1.effect.form.formula')} error={rowProblem(index, 'formula')}>
              <input type="text" value={row.formula} onChange={(event) => setRow(index, { formula: event.target.value })} />
            </FormField>
            {form.indicators.length > 1 ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="remove-indicator" onClick={() => set({ indicators: form.indicators.filter((_, at) => at !== index) })}>
                {t('mr1.effect.form.remove', { row: index + 1 })}
              </button>
            ) : null}
          </fieldset>
        ))}
        {problems.indicators === undefined ? null : (
          <p className="field-error" role="alert">
            {problemText(t, problems.indicators)}
          </p>
        )}
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="add-indicator" disabled={form.indicators.length >= MAX_INDICATORS} onClick={() => set({ indicators: [...form.indicators, { ...EMPTY_INDICATOR }] })}>
          {t('mr1.effect.form.add')}
        </button>
      </div>
    </ConfirmDialog>
  );
}

// ---- fixing a draft -------------------------------------------------------------------------------------------------------------

/** Fixing the draft: a person other than its drafter, under the version of the draft they read. */
export function FixDialog({ view, set, onClose, onDone }: DialogProps & { set: TargetSet }) {
  const { t } = useTranslation();
  const fix = useFixTargets();
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('mr1.effect.fix.title')}
      context={[
        { label: t('mr1.effect.ctx.project'), value: view.project.code },
        { label: t('mr1.effect.fixed.version'), value: String(set.versionNo) },
        { label: t('mr1.effect.fixed.basis'), value: set.basis },
        { label: t('mr1.effect.fixed.drafter'), value: personName(set.draftedBy) },
        { label: t('mr1.effect.fix.effect'), value: view.fixed === null ? t('mr1.effect.fix.effect.first') : t('mr1.effect.fix.effect.revision') },
      ]}
      confirmLabel={t('mr1.effect.fix.confirm')}
      cancelLabel={t('mr1.effect.common.cancel')}
      pending={fix.isPending}
      {...(refusal === undefined ? {} : { error: refusal })}
      onCancel={onClose}
      onConfirm={() => {
        setRefusal(undefined);
        fix.mutate(
          { id: set.id, version: set.version },
          {
            onSuccess: () => {
              onDone(t('mr1.effect.fix.done'));
              onClose();
            },
            onError: (error) => setRefusal(refusalText(t, describeRefusal(error))),
          },
        );
      }}
    >
      <p className="callout" data-testid="fix-rule">
        {t('mr1.effect.fix.rule')}
      </p>
    </ConfirmDialog>
  );
}

// ---- an actual value ------------------------------------------------------------------------------------------------------------

export interface MeasureDialogProps extends DialogProps {
  /** A row to correct: the dialog opens on its indicator, with the correction already chosen. */
  correcting?: Measurement;
}

/** Recording an actual value; a correction is a later row that names the row it corrects and says why (nothing is overwritten). */
export function MeasureDialog({ view, correcting, onClose, onDone }: MeasureDialogProps) {
  const { t } = useTranslation();
  const record = useRecordMeasurement();
  const indicators = view.fixed?.indicators ?? [];
  const [form, setForm] = useState<MeasureForm>(() => ({ ...EMPTY_MEASURE, indicatorCode: correcting?.indicatorCode ?? indicators[0]?.code ?? '', correctsId: correcting?.id ?? '' }));
  const [asCorrection, setAsCorrection] = useState(correcting !== undefined);
  const [problems, setProblems] = useState<Partial<Record<MeasureField, FormProblem>>>({});
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const set = (patch: Partial<MeasureForm>): void => setForm((current) => ({ ...current, ...patch }));
  const error = (field: MeasureField): string | undefined => (problems[field] === undefined ? undefined : problemText(t, problems[field]));
  const rows = view.measurements.filter((row) => row.indicatorCode === form.indicatorCode && !row.corrected);
  const unit = indicators.find((line) => line.code === form.indicatorCode)?.unit;

  const confirm = (): void => {
    const next: MeasureForm = asCorrection ? form : { ...form, correctsId: '', correctionReason: '' };
    const found = validateMeasure(next, vietnamToday());
    setProblems(found);
    const first = firstOf(found);
    if (first !== undefined) {
      setRefusal(t('mr1.effect.validation.field', { field: measureFieldText(t, first as MeasureField) }));
      return;
    }
    setRefusal(undefined);
    record.mutate(
      { projectId: view.project.id, body: measureBody(next) },
      {
        onSuccess: () => {
          onDone(asCorrection ? t('mr1.effect.measure.doneCorrection') : t('mr1.effect.measure.done'));
          onClose();
        },
        onError: (failure) => setRefusal(refusalText(t, describeRefusal(failure))),
      },
    );
  };

  return (
    <ConfirmDialog
      open
      title={asCorrection ? t('mr1.effect.measure.titleCorrection') : t('mr1.effect.measure.title')}
      context={[{ label: t('mr1.effect.ctx.project'), value: view.project.code }]}
      confirmLabel={t('mr1.effect.measure.confirm')}
      cancelLabel={t('mr1.effect.common.cancel')}
      pending={record.isPending}
      {...(refusal === undefined ? {} : { error: refusal })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="eff-form" data-testid="measure-form">
        <FormField id="measure-indicator" label={t('mr1.effect.form.indicatorCode')} error={error('indicatorCode')}>
          <select value={form.indicatorCode} disabled={correcting !== undefined} onChange={(event) => set({ indicatorCode: event.target.value, correctsId: '' })}>
            {indicators.map((line) => (
              <option key={line.code} value={line.code}>
                {line.code} · {line.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="measure-on" label={t('mr1.effect.form.measuredOn')} error={error('measuredOn')}>
          <input type="date" value={form.measuredOn} max={vietnamToday()} onChange={(event) => set({ measuredOn: event.target.value })} />
        </FormField>
        <FormField id="measure-value" label={unit === undefined ? t('mr1.effect.form.value') : t('mr1.effect.form.valueUnit', { unit })} error={error('value')} hint={t('mr1.effect.form.decimal.hint')}>
          <input type="text" inputMode="decimal" value={form.value} onChange={(event) => set({ value: event.target.value })} />
        </FormField>
        <FormField id="measure-method" label={t('mr1.effect.form.methodNote')} error={error('methodNote')} hint={t('mr1.effect.form.methodNote.hint')}>
          <textarea rows={3} value={form.methodNote} onChange={(event) => set({ methodNote: event.target.value })} />
        </FormField>
        <FormField id="measure-evidence" label={t('mr1.effect.form.evidence')} error={error('evidenceDocumentId')} hint={t('mr1.effect.form.optional')}>
          <input type="text" value={form.evidenceDocumentId} onChange={(event) => set({ evidenceDocumentId: event.target.value })} />
        </FormField>
        <label className="eff-check">
          <input
            type="checkbox"
            checked={asCorrection}
            disabled={correcting !== undefined || rows.length === 0}
            onChange={(event) => {
              setAsCorrection(event.target.checked);
              set({ correctsId: event.target.checked ? (rows[0]?.id ?? '') : '' });
            }}
          />{' '}
          {t('mr1.effect.form.corrects')}
        </label>
        {asCorrection ? (
          <>
            <FormField id="measure-corrects" label={t('mr1.effect.form.correctsId')} error={error('correctsId')}>
              <select value={form.correctsId} disabled={correcting !== undefined} onChange={(event) => set({ correctsId: event.target.value })}>
                {(correcting === undefined ? rows : [correcting]).map((row) => (
                  <option key={row.id} value={row.id}>
                    {dayText(row.measuredOn)} · {row.value}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="measure-reason" label={t('mr1.effect.form.correctionReason')} error={error('correctionReason')} hint={t('mr1.effect.form.correctionReason.hint')}>
              <textarea rows={3} value={form.correctionReason} onChange={(event) => set({ correctionReason: event.target.value })} />
            </FormField>
          </>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

function measureFieldText(t: Translate, field: MeasureField): string {
  switch (field) {
    case 'indicatorCode':
      return t('mr1.effect.form.indicatorCode');
    case 'measuredOn':
      return t('mr1.effect.form.measuredOn');
    case 'value':
      return t('mr1.effect.form.value');
    case 'methodNote':
      return t('mr1.effect.form.methodNote');
    case 'evidenceDocumentId':
      return t('mr1.effect.form.evidence');
    case 'correctsId':
      return t('mr1.effect.form.correctsId');
    case 'correctionReason':
      return t('mr1.effect.form.correctionReason');
  }
}

// ---- the calendar ---------------------------------------------------------------------------------------------------------------

/** Generating the calendar of Articles 76 and 77: it is made once, from the anchor days the project has; what waits for an anchor day is said afterwards. */
export function CalendarDialog({ view, onClose, onDone, onResult }: DialogProps & { onResult: (result: CalendarResult) => void }) {
  const { t } = useTranslation();
  const generate = useGenerateCalendar();
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('mr1.effect.calendar.generate.title')}
      context={[
        { label: t('mr1.effect.ctx.project'), value: view.project.code },
        { label: t('mr1.effect.calendar.generate.effect'), value: t('mr1.effect.calendar.generate.note') },
      ]}
      confirmLabel={t('mr1.effect.calendar.generate.confirm')}
      cancelLabel={t('mr1.effect.common.cancel')}
      pending={generate.isPending}
      {...(refusal === undefined ? {} : { error: refusal })}
      onCancel={onClose}
      onConfirm={() => {
        setRefusal(undefined);
        generate.mutate(
          { projectId: view.project.id },
          {
            onSuccess: (result) => {
              onResult(result);
              onDone(t('mr1.effect.calendar.generate.done'));
              onClose();
            },
            onError: (error) => setRefusal(refusalText(t, describeRefusal(error))),
          },
        );
      }}
    >
      <p className="callout warning" data-testid="calendar-dialog-notice">
        {t('mr1.effect.calendar.unverified')}
      </p>
    </ConfirmDialog>
  );
}

/** What the generation made and what waits for an anchor day, in words. */
export function calendarResultLines(t: Translate, result: CalendarResult): string[] {
  const made = result.created.map((entry) => t('mr1.effect.calendar.result.created', { kind: kindText(t, entry.kind), due: dayText(entry.dueOn) }));
  const waiting = result.waiting.map((entry) => t('mr1.effect.calendar.result.waiting', { kind: kindText(t, entry.kind), anchor: anchorText(t, entry.anchor) }));
  return made.length === 0 && waiting.length === 0 ? [t('mr1.effect.calendar.result.nothing')] : [...made, ...waiting];
}

// ---- an assessment --------------------------------------------------------------------------------------------------------------

/** Submitting an assessment: the figures are frozen into it by the server; the conclusion starts at the one the figures suggest. */
export function AssessDialog({ view, onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const submit = useSubmitAssessment();
  const nextDue = [...view.calendar].filter((entry) => entry.status === 'PLANNED').sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
  const [form, setForm] = useState<AssessForm>({ kind: nextDue?.kind ?? 'AD_HOC', conclusion: view.suggestedConclusion ?? 'PARTIALLY_SATISFACTORY', summary: '' });
  const [problems, setProblems] = useState<Partial<Record<'summary', FormProblem>>>({});
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const confirm = (): void => {
    const found = validateAssess(form);
    setProblems(found);
    if (found.summary !== undefined) {
      setRefusal(t('mr1.effect.validation.field', { field: t('mr1.effect.form.summary') }));
      return;
    }
    setRefusal(undefined);
    submit.mutate(
      { projectId: view.project.id, body: assessBody(form) },
      {
        onSuccess: () => {
          onDone(t('mr1.effect.assess.done'));
          onClose();
        },
        onError: (error) => setRefusal(refusalText(t, describeRefusal(error))),
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={t('mr1.effect.assess.title')}
      context={[
        { label: t('mr1.effect.ctx.project'), value: view.project.code },
        { label: t('mr1.effect.assess.effect'), value: t('mr1.effect.assess.effect.text') },
      ]}
      confirmLabel={t('mr1.effect.assess.confirm')}
      cancelLabel={t('mr1.effect.common.cancel')}
      pending={submit.isPending}
      {...(refusal === undefined ? {} : { error: refusal })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="eff-form" data-testid="assess-form">
        <FormField id="assess-kind" label={t('mr1.effect.form.kind')} error={undefined}>
          <select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: ASSESSMENT_KINDS.find((kind) => kind === event.target.value) ?? 'AD_HOC' }))}>
            {ASSESSMENT_KINDS.map((kind: AssessmentKind) => (
              <option key={kind} value={kind}>
                {kindText(t, kind)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          id="assess-conclusion"
          label={t('mr1.effect.form.conclusion')}
          error={undefined}
          hint={view.suggestedConclusion === null ? t('mr1.effect.form.conclusion.none') : t('mr1.effect.form.conclusion.suggested', { conclusion: conclusionText(t, view.suggestedConclusion) })}
        >
          <select value={form.conclusion} onChange={(event) => setForm((current) => ({ ...current, conclusion: (CONCLUSIONS.find((conclusion) => conclusion === event.target.value) ?? 'PARTIALLY_SATISFACTORY') as Conclusion }))}>
            {CONCLUSIONS.map((conclusion) => (
              <option key={conclusion} value={conclusion}>
                {conclusionText(t, conclusion)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="assess-summary" label={t('mr1.effect.form.summary')} error={problems.summary === undefined ? undefined : problemText(t, problems.summary)} hint={t('mr1.effect.form.summary.hint')}>
          <textarea rows={4} value={form.summary} onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))} />
        </FormField>
      </div>
    </ConfirmDialog>
  );
}

// ---- the decision on an assessment ----------------------------------------------------------------------------------------------

/** Approving or returning an assessment under the version that was read; a return must give a reason of at least ten characters, and the person who decides is not the person who submitted. */
export function DecideDialog({ view, assessment, decision, onClose, onDone }: DialogProps & { assessment: Assessment; decision: 'APPROVE' | 'RETURN' }) {
  const { t } = useTranslation();
  const decide = useDecideAssessment();
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const returning = decision === 'RETURN';
  return (
    <ConfirmDialog
      open
      title={returning ? t('mr1.effect.decide.returnTitle') : t('mr1.effect.decide.approveTitle')}
      context={[
        { label: t('mr1.effect.ctx.project'), value: view.project.code },
        { label: t('mr1.effect.assessment.kind'), value: kindText(t, assessment.kind) },
        { label: t('mr1.effect.assessment.conclusion'), value: conclusionText(t, assessment.conclusion) },
      ]}
      confirmLabel={returning ? t('mr1.effect.decide.return') : t('mr1.effect.decide.approve')}
      cancelLabel={t('mr1.effect.common.cancel')}
      pending={decide.isPending}
      reason={returning ? { label: t('mr1.effect.decide.reason'), required: true, minLength: MIN_RETURN_REASON, hint: t('mr1.effect.decide.reason.hint', { count: MIN_RETURN_REASON }) } : { label: t('mr1.effect.decide.reasonOptional') }}
      {...(refusal === undefined ? {} : { error: refusal })}
      onCancel={onClose}
      onConfirm={(reason) => {
        setRefusal(undefined);
        decide.mutate(
          { id: assessment.id, version: assessment.version, body: decisionBody(decision, reason ?? '') },
          {
            onSuccess: () => {
              onDone(returning ? t('mr1.effect.decide.doneReturn') : t('mr1.effect.decide.doneApprove'));
              onClose();
            },
            onError: (error) => setRefusal(refusalText(t, describeRefusal(error))),
          },
        );
      }}
    >
      <MakerCheckerBadge maker={personName(assessment.submittedBy)} checker={null} />
      <p className="callout" data-testid="decide-rule">
        {t('mr1.effect.decide.rule')}
      </p>
    </ConfirmDialog>
  );
}
