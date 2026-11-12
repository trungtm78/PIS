import { useId, useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { FormProblem } from '../model';
import { ScoreProblemBanner } from './components';
import { scoreFormProblem } from './labels';
import {
  ADJUSTMENT_REASON_MAX,
  CONCLUSION_MAX,
  CONCLUSION_MIN,
  DECISION_NOTE_MAX,
  DECISION_NOTE_MIN,
  EMPTY_ADJUSTMENT,
  EMPTY_HANDLE,
  EVIDENCE_REF_MAX,
  RESPONSE_MAX,
  RESPONSE_MIN,
  adjustmentBody,
  decisionBody,
  describeScoreProblem,
  handleBody,
  isScoreConflict,
  responseProblem,
  validateAdjustment,
  validateHandle,
} from './model';
import type { Adjustment, AdjustmentForm, DecisionKind, HandleForm, ScoreProblem, ScoreResponse } from './model';

interface FieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  problem: FormProblem | undefined;
  show: boolean;
  limits?: { min?: number; max?: number };
  hint?: string | undefined;
  multiline?: boolean;
  disabled?: boolean;
}

/** A label, the control and the problem in words next to it (never colour alone). */
function Field({ label, name, value, onChange, problem, show, limits, hint, multiline, disabled }: FieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const invalid = show && problem !== undefined;
  const describedBy = [invalid ? `${id}-error` : '', hint === undefined ? '' : `${id}-hint`].filter((part) => part !== '').join(' ');
  const common = { id, value, disabled: disabled === true, 'aria-invalid': invalid, 'aria-describedby': describedBy === '' ? undefined : describedBy, 'data-testid': `field-${name}`, autoComplete: 'off' };
  return (
    <div className="pwf-field pwf-field--wide">
      <label htmlFor={id}>{label}</label>
      {multiline === true ? <textarea rows={4} {...common} onChange={(event) => onChange(event.target.value)} /> : <input type="text" {...common} onChange={(event) => onChange(event.target.value)} />}
      {hint === undefined ? null : (
        <span className="gova1-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {invalid && problem !== undefined ? (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${name}`}>
          <span aria-hidden="true">⚠ </span>
          {scoreFormProblem(t, problem, limits)}
        </span>
      ) : null}
    </div>
  );
}

interface Settled {
  /** Runs the command; rejects with the refusal of the server. */
  run: () => Promise<unknown>;
}

/** What a form does around its command: the refusal shown, the busy state, and the reload of a stale version. */
function useSubmit(): { problem: ScoreProblem | undefined; busy: boolean; submit: (settled: Settled) => Promise<boolean>; clear: () => void } {
  const [problem, setProblem] = useState<ScoreProblem | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  return {
    problem,
    busy,
    clear: () => setProblem(undefined),
    submit: async ({ run }) => {
      setBusy(true);
      setProblem(undefined);
      try {
        await run();
        return true;
      } catch (error) {
        setProblem(describeScoreProblem(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

// ---- the response of the person scored ---------------------------------------------------------------------------------------------------------------------------

export interface ResponseFormProps {
  onSend: (body: string) => Promise<unknown>;
  onReload: () => void;
}

/** The response of the person scored (at least twenty characters); a closed window or a response already in the approval workflow is said in words, the text kept. */
export function ResponseForm({ onSend, onReload }: ResponseFormProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [attempted, setAttempted] = useState(false);
  const { problem, busy, submit } = useSubmit();
  const found = responseProblem(body);
  return (
    <form
      className="pwfs-form"
      data-testid="response-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (found !== undefined) return;
        void submit({ run: () => onSend(body.trim()) }).then((done) => {
          if (done) {
            setBody('');
            setAttempted(false);
          }
        });
      }}
    >
      <Field label={t('pwfs.response.body.label')} name="response-body" value={body} multiline onChange={setBody} problem={found} show={attempted} limits={{ min: RESPONSE_MIN, max: RESPONSE_MAX }} hint={t('pwfs.response.body.hint', { min: RESPONSE_MIN })} />
      {problem === undefined ? null : <ScoreProblemBanner problem={problem} onReload={onReload} />}
      <p className="pwfs-actions">
        <button type="submit" className="ui-button" disabled={busy} data-action="send-response">
          {t('pwfs.response.send.action')}
        </button>
      </p>
    </form>
  );
}

// ---- an adjustment requested by a manager ---------------------------------------------------------------------------------------------------------------------

export interface AdjustmentFormProps {
  limits: { ceiling: number; reasonMin: number };
  onSend: (form: ReturnType<typeof adjustmentBody>) => Promise<unknown>;
  onReload: () => void;
}

export function AdjustmentRequestForm({ limits, onSend, onReload }: AdjustmentFormProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<AdjustmentForm>(EMPTY_ADJUSTMENT);
  const [attempted, setAttempted] = useState(false);
  const { problem, busy, submit } = useSubmit();
  const problems = validateAdjustment(form, limits);
  const set = (patch: Partial<AdjustmentForm>): void => setForm({ ...form, ...patch });
  return (
    <form
      className="pwfs-form"
      data-testid="adjustment-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (Object.keys(problems).length > 0) return;
        void submit({ run: () => onSend(adjustmentBody(form)) }).then((done) => {
          if (done) {
            setForm(EMPTY_ADJUSTMENT);
            setAttempted(false);
          }
        });
      }}
    >
      <Field label={t('pwfs.adjustment.points.label')} name="points" value={form.points} onChange={(points) => set({ points })} problem={problems.points} show={attempted} limits={{ max: limits.ceiling }} hint={t('pwfs.adjustment.points.hint', { max: limits.ceiling })} />
      <Field label={t('pwfs.adjustment.reason.label')} name="reason" value={form.reason} multiline onChange={(reason) => set({ reason })} problem={problems.reason} show={attempted} limits={{ min: limits.reasonMin, max: ADJUSTMENT_REASON_MAX }} hint={t('pwfs.adjustment.reason.hint', { min: limits.reasonMin })} />
      <Field label={t('pwfs.adjustment.evidence.label')} name="evidence" value={form.evidenceRef} onChange={(evidenceRef) => set({ evidenceRef })} problem={problems.evidenceRef} show={attempted} limits={{ max: EVIDENCE_REF_MAX }} />
      {problem === undefined ? null : <ScoreProblemBanner problem={problem} onReload={onReload} />}
      <p className="pwfs-actions">
        <button type="submit" className="ui-button" disabled={busy} data-action="send-adjustment">
          {t('pwfs.adjustment.send.action')}
        </button>
      </p>
    </form>
  );
}

// ---- the decision on an adjustment, by a second person ---------------------------------------------------------------------------------------------------------

export interface DecisionFormProps {
  adjustment: Adjustment;
  onDecide: (adjustment: Adjustment, body: NonNullable<Exclude<ReturnType<typeof decisionBody>, FormProblem>>) => Promise<unknown>;
  onReload: () => void;
}

/** Approve or reject an adjustment somebody else asked for; a rejection says why (the note is at least five characters). */
export function DecisionForm({ adjustment, onDecide, onReload }: DecisionFormProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [shown, setShown] = useState<FormProblem | undefined>(undefined);
  const { problem, busy, submit } = useSubmit();
  const decide = (decision: DecisionKind): void => {
    const body = decisionBody(decision, note);
    if (typeof body === 'string') {
      setShown(body);
      return;
    }
    setShown(undefined);
    void submit({ run: () => onDecide(adjustment, body) });
  };
  return (
    <div className="pwfs-form" data-testid={`decision-${adjustment.id}`}>
      <Field label={t('pwfs.decision.note.label')} name={`note-${adjustment.id}`} value={note} onChange={setNote} problem={shown} show={shown !== undefined} limits={{ min: DECISION_NOTE_MIN, max: DECISION_NOTE_MAX }} hint={t('pwfs.decision.note.hint')} />
      {problem === undefined ? null : <ScoreProblemBanner problem={problem} onReload={isScoreConflict(problem) ? onReload : undefined} />}
      <p className="pwfs-actions">
        <button type="button" className="ui-button" disabled={busy} data-action={`approve-${adjustment.id}`} onClick={() => decide('APPROVE')}>
          {t('pwfs.decision.approve.action')}
        </button>
        <button type="button" className="ui-button ui-button--outline" disabled={busy} data-action={`reject-${adjustment.id}`} onClick={() => decide('REJECT')}>
          {t('pwfs.decision.reject.action')}
        </button>
      </p>
    </div>
  );
}

// ---- handling a response ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface HandleFormProps {
  response: ScoreResponse;
  limits: { ceiling: number; reasonMin: number };
  onHandle: (response: ScoreResponse, body: ReturnType<typeof handleBody>) => Promise<unknown>;
  onReload: () => void;
}

/** Handles an open response: the score is kept, or an adjustment is asked for (its points and reason are asked only then; a second person decides it). */
export function HandleResponseForm({ response, limits, onHandle, onReload }: HandleFormProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<HandleForm>(EMPTY_HANDLE);
  const [attempted, setAttempted] = useState(false);
  const { problem, busy, submit } = useSubmit();
  const problems = validateHandle(form, limits);
  const set = (patch: Partial<HandleForm>): void => setForm({ ...form, ...patch });
  const id = useId();
  return (
    <form
      className="pwfs-form"
      data-testid={`handle-${response.id}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (Object.keys(problems).length > 0) return;
        void submit({ run: () => onHandle(response, handleBody(form)) });
      }}
    >
      <div className="pwf-field">
        <label htmlFor={`${id}-outcome`}>{t('pwfs.handle.outcome.label')}</label>
        <select id={`${id}-outcome`} value={form.outcome} data-testid="field-outcome" onChange={(event) => set({ outcome: event.target.value as HandleForm['outcome'] })}>
          <option value="KEEP">{t('pwfs.handle.keep.option')}</option>
          <option value="ADJUST">{t('pwfs.handle.adjust.option')}</option>
        </select>
      </div>
      <Field label={t('pwfs.handle.conclusion.label')} name="conclusion" value={form.conclusion} multiline onChange={(conclusion) => set({ conclusion })} problem={problems.conclusion} show={attempted} limits={{ min: CONCLUSION_MIN, max: CONCLUSION_MAX }} />
      {form.outcome === 'ADJUST' ? (
        <>
          <Field label={t('pwfs.adjustment.points.label')} name="handle-points" value={form.points} onChange={(points) => set({ points })} problem={problems.points} show={attempted} limits={{ max: limits.ceiling }} hint={t('pwfs.adjustment.points.hint', { max: limits.ceiling })} />
          <Field label={t('pwfs.adjustment.reason.label')} name="handle-reason" value={form.reason} multiline onChange={(reason) => set({ reason })} problem={problems.reason} show={attempted} limits={{ min: limits.reasonMin, max: ADJUSTMENT_REASON_MAX }} />
        </>
      ) : null}
      {problem === undefined ? null : <ScoreProblemBanner problem={problem} onReload={isScoreConflict(problem) ? onReload : undefined} />}
      <p className="pwfs-actions">
        <button type="submit" className="ui-button" disabled={busy} data-action={`handle-${response.id}`}>
          {t('pwfs.handle.send.action')}
        </button>
      </p>
    </form>
  );
}
