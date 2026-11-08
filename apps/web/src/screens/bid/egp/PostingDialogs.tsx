import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { useCancelPosting, useOpenPosting, usePostingDetail, usePreparePosting, useReceiptPosting, useRejectPosting, useReload, useSubmitPosting, useSweepPostings } from './posting-hooks';
import { fieldLabel, invalidText, kindLabel, problemText, stateLabel, subjectHint } from './posting-labels';
import {
  CTR_EXPORT_PATH,
  EMPTY_OPEN,
  EXPORT_KINDS,
  KINDS,
  MAX_CODE,
  MAX_RECEIPT,
  MIN_CANCEL_REASON,
  MIN_REJECT_REASON,
  PACKAGE_KINDS,
  describeProblem,
  instantDay,
  openBody,
  prepareBody,
  reasonProblem,
  receiptBody,
  shortHash,
  stamp,
  validateOpen,
  validatePrepare,
  validateReceipt,
  validateSweep,
  vietnamToday,
} from './posting-model';
import type { FieldProblem, OpenForm, PostingKind, PostingRow, Problem } from './posting-model';
import './posting.css';

type T = Translator['t'];

export type PostingDialog =
  | { kind: 'prepare'; row: PostingRow }
  | { kind: 'submit'; row: PostingRow }
  | { kind: 'receipt'; row: PostingRow }
  | { kind: 'reject'; row: PostingRow }
  | { kind: 'cancel'; row: PostingRow }
  | { kind: 'open'; nonce: number }
  | { kind: 'sweep'; nonce: number };

export interface PostingDialogsProps {
  dialog: PostingDialog | undefined;
  onClose: () => void;
  /** Called after a command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

/** The dialogs of the commands of BID-32: each names the duty and the effect, asks for what the command needs, locks while it sends and says in place why it was refused. */
export function PostingDialogs({ dialog, onClose, onDone }: PostingDialogsProps) {
  if (dialog === undefined) return null;
  switch (dialog.kind) {
    case 'prepare':
      return <PrepareDialog key={`prepare:${dialog.row.id}`} row={dialog.row} onClose={onClose} onDone={onDone} />;
    case 'submit':
      return <SubmitDialog key={`submit:${dialog.row.id}`} row={dialog.row} onClose={onClose} onDone={onDone} />;
    case 'receipt':
      return <ReceiptDialog key={`receipt:${dialog.row.id}`} row={dialog.row} onClose={onClose} onDone={onDone} />;
    case 'reject':
    case 'cancel':
      return <ReasonDialog key={`${dialog.kind}:${dialog.row.id}`} mode={dialog.kind} row={dialog.row} onClose={onClose} onDone={onDone} />;
    case 'open':
      return <OpenDialog key={`open:${dialog.nonce}`} onClose={onClose} onDone={onDone} />;
    case 'sweep':
      return <SweepDialog key={`sweep:${dialog.nonce}`} onClose={onClose} onDone={onDone} />;
  }
}

const contextOf = (t: T, row: PostingRow): Array<{ label: string; value: string }> => [
  { label: t('egp.posting.column.kind'), value: row.obligation ?? kindLabel(t, row.kind) },
  { label: t('egp.posting.column.subject'), value: row.subjectCode },
  { label: t('egp.posting.column.due'), value: instantDay(row.dueAt) },
  { label: t('egp.posting.column.state'), value: stateLabel(t, row.state) },
];

/** The reload that a version conflict offers: what the screen reads is read again and the dialog closes. */
function Reload({ problem, onClose }: { problem: Problem | undefined; onClose: () => void }): ReactNode {
  const { t } = useTranslation();
  const reload = useReload();
  if (problem?.kind !== 'versionConflict') return null;
  return (
    <button
      type="button"
      className="ui-button ui-button--outline ui-button--small"
      onClick={() => {
        void reload();
        onClose();
      }}
    >
      {t('egp.posting.problem.reload.action')}
    </button>
  );
}

function useSending() {
  const sending = useRef(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  return {
    problem,
    clear: () => setProblem(undefined),
    /** Starts one send: false while another is on its way. */
    begin: (): boolean => {
      if (sending.current) return false;
      sending.current = true;
      setProblem(undefined);
      return true;
    },
    fail: (failure: unknown): void => {
      sending.current = false;
      setProblem(describeProblem(failure));
    },
    end: (): void => {
      sending.current = false;
    },
  };
}

const named = (t: T, problem: Problem | undefined, field: string): string | undefined => (problem?.field === field && problem.kind !== 'versionConflict' ? problemText(t, problem) : undefined);

interface DialogProps {
  row: PostingRow;
  onClose: () => void;
  onDone: (receipt: string) => void;
}

function PrepareDialog({ row, onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const detail = usePostingDetail(row.id);
  const prepare = usePreparePosting();
  const send = useSending();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState('');
  const [useBatch, setUseBatch] = useState(false);
  const [errors, setErrors] = useState<Record<string, FieldProblem>>({});
  const required = detail.data?.requiredFields ?? [];
  const suggested = detail.data?.suggestedFields ?? {};
  const exportKind = EXPORT_KINDS.includes(row.kind);
  const valueOf = (name: string): string => typed[name] ?? suggested[name] ?? '';

  const confirm = (): void => {
    const form = { fields: Object.fromEntries(required.map((name) => [name, valueOf(name)])), exportBatchId: batch };
    const found = validatePrepare(row.kind, required, form, useBatch);
    setErrors(found);
    if (Object.keys(found).length > 0 || !send.begin()) return;
    prepare.mutate(
      { id: row.id, version: row.version, body: prepareBody(required, form, useBatch) },
      {
        onSuccess: () => {
          send.end();
          onDone(t('egp.posting.success.prepared', { kind: kindLabel(t, row.kind), code: row.subjectCode }));
          onClose();
        },
        onError: send.fail,
      },
    );
  };
  const summary = Object.keys(errors).length > 0 ? t('egp.posting.invalid.summary') : undefined;
  // A refusal that names a field of the form is said under that field, not twice.
  const inline = send.problem?.field !== undefined && (required.includes(send.problem.field) || send.problem.field === 'export_batch_id');
  const loading = detail.isLoading;
  const failed = detail.isError;

  return (
    <ConfirmDialog
      open
      title={t('egp.posting.prepare.title')}
      context={contextOf(t, row)}
      confirmLabel={t('egp.posting.prepare.confirm.action')}
      cancelLabel={t('egp.posting.dialog.cancel.action')}
      pending={prepare.isPending || loading || failed}
      {...(summary !== undefined ? { error: summary } : send.problem === undefined || inline ? {} : { error: problemText(t, send.problem) })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="posting-form">
        <p className="sub">{t('egp.posting.prepare.effect')}</p>
        <p className="sub">{t('egp.posting.dialog.maker.note')}</p>
        {loading && (
          <p role="status" data-testid="prepare-loading">
            {t('egp.posting.prepare.loading')}
          </p>
        )}
        {failed && (
          <p role="alert" data-testid="prepare-error">
            {t('egp.posting.prepare.error')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void detail.refetch()}>
              {t('states.retry.action')}
            </button>
          </p>
        )}
        {exportKind && detail.data !== undefined && (
          <fieldset className="posting-source">
            <legend>{t('egp.posting.prepare.source.legend')}</legend>
            <label>
              <input type="radio" name="posting-source" checked={!useBatch} onChange={() => setUseBatch(false)} /> {t('egp.posting.prepare.source.fields')}
            </label>
            <label>
              <input type="radio" name="posting-source" checked={useBatch} onChange={() => setUseBatch(true)} /> {t('egp.posting.prepare.source.batch')}
            </label>
          </fieldset>
        )}
        {useBatch && (
          <div className="field">
            <label htmlFor="posting-batch">{t('egp.posting.prepare.batch.label')}</label>
            <input id="posting-batch" value={batch} autoComplete="off" aria-invalid={errors.export_batch_id !== undefined || undefined} onChange={(event) => setBatch(event.target.value)} />
            <span className="sub">
              {t('egp.posting.prepare.batch.hint')} <Link to={CTR_EXPORT_PATH}>{t('egp.posting.prepare.batch.link')}</Link>
            </span>
            {(errors.export_batch_id !== undefined || named(t, send.problem, 'export_batch_id') !== undefined) && (
              <span className="posting-error" role="alert">
                {errors.export_batch_id === undefined ? named(t, send.problem, 'export_batch_id') : invalidText(t, errors.export_batch_id)}
              </span>
            )}
          </div>
        )}
        {!useBatch && Object.keys(suggested).length > 0 && (
          <p className="callout" data-testid="suggested-note">
            {t('egp.posting.prepare.suggested.note')}
          </p>
        )}
        {!useBatch &&
          required.map((name) => {
            const message = errors[name] === undefined ? named(t, send.problem, name) : invalidText(t, errors[name] as FieldProblem);
            return (
              <div className="field" key={name}>
                <label htmlFor={`posting-field-${name}`}>{fieldLabel(t, name)}</label>
                <input
                  id={`posting-field-${name}`}
                  value={valueOf(name)}
                  autoComplete="off"
                  aria-invalid={message !== undefined || undefined}
                  aria-describedby={message === undefined ? undefined : `posting-field-${name}-error`}
                  onChange={(event) => {
                    setTyped((previous) => ({ ...previous, [name]: event.target.value }));
                    setErrors({});
                    send.clear();
                  }}
                />
                {message !== undefined && (
                  <span className="posting-error" id={`posting-field-${name}-error`}>
                    {message}
                  </span>
                )}
              </div>
            );
          })}
        <Reload problem={send.problem} onClose={onClose} />
      </div>
    </ConfirmDialog>
  );
}

function SubmitDialog({ row, onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const submit = useSubmitPosting();
  const send = useSending();
  const confirm = (): void => {
    if (!send.begin()) return;
    submit.mutate(
      { id: row.id, version: row.version },
      {
        onSuccess: () => {
          send.end();
          onDone(t('egp.posting.success.submitted', { kind: kindLabel(t, row.kind), code: row.subjectCode }));
          onClose();
        },
        onError: send.fail,
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={t('egp.posting.submit.title')}
      context={[
        ...contextOf(t, row),
        ...(row.preparedByName === null ? [] : [{ label: t('egp.posting.dialog.preparedBy.label'), value: row.preparedByName }]),
        ...(row.packetSha256 === null ? [] : [{ label: t('egp.posting.column.packet'), value: shortHash(row.packetSha256) }]),
      ]}
      confirmLabel={t('egp.posting.submit.confirm.action')}
      cancelLabel={t('egp.posting.dialog.cancel.action')}
      pending={submit.isPending}
      {...(send.problem === undefined ? {} : { error: problemText(t, send.problem) })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <p className="sub">{t('egp.posting.submit.effect')}</p>
      <p className="sub">{t('egp.posting.dialog.maker.note')}</p>
      <Reload problem={send.problem} onClose={onClose} />
    </ConfirmDialog>
  );
}

function ReceiptDialog({ row, onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const receipt = useReceiptPosting();
  const send = useSending();
  const [ref, setRef] = useState('');
  const [at, setAt] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'receiptRef' | 'receiptedAt', FieldProblem>>>({});
  const confirm = (): void => {
    const form = { receiptRef: ref, receiptedAt: at };
    const found = validateReceipt(form, new Date(), row.submittedAt);
    setErrors(found);
    if (Object.keys(found).length > 0 || !send.begin()) return;
    receipt.mutate(
      { id: row.id, version: row.version, body: receiptBody(form) },
      {
        onSuccess: () => {
          send.end();
          onDone(t('egp.posting.success.receipted', { kind: kindLabel(t, row.kind), code: row.subjectCode, ref: ref.trim() }));
          onClose();
        },
        onError: send.fail,
      },
    );
  };
  const refMessage = errors.receiptRef === undefined ? named(t, send.problem, 'receiptRef') : invalidText(t, errors.receiptRef);
  const atMessage = errors.receiptedAt === undefined ? named(t, send.problem, 'receiptedAt') : invalidText(t, errors.receiptedAt);
  const summary = Object.keys(errors).length > 0 ? t('egp.posting.invalid.summary') : undefined;
  return (
    <ConfirmDialog
      open
      title={t('egp.posting.receipt.title')}
      context={[...contextOf(t, row), ...(row.submittedAt === null ? [] : [{ label: t('egp.posting.dialog.submittedAt.label'), value: stamp(row.submittedAt) }])]}
      confirmLabel={t('egp.posting.receipt.confirm.action')}
      cancelLabel={t('egp.posting.dialog.cancel.action')}
      pending={receipt.isPending}
      {...(summary !== undefined ? { error: summary } : send.problem === undefined || send.problem.field !== undefined ? {} : { error: problemText(t, send.problem) })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="posting-form">
        <p className="sub">{t('egp.posting.receipt.effect')}</p>
        <div className="field">
          <label htmlFor="posting-receipt-ref">{t('egp.posting.receipt.ref.label')}</label>
          <input id="posting-receipt-ref" value={ref} maxLength={MAX_RECEIPT + 20} autoComplete="off" aria-invalid={refMessage !== undefined || undefined} aria-describedby={refMessage === undefined ? undefined : 'posting-receipt-ref-error'} onChange={(event) => { setRef(event.target.value); setErrors({}); send.clear(); }} />
          <span className="sub">{t('egp.posting.receipt.ref.hint')}</span>
          {refMessage !== undefined && (
            <span className="posting-error" id="posting-receipt-ref-error" role="alert">
              {refMessage}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="posting-receipt-at">{t('egp.posting.receipt.at.label')}</label>
          <input id="posting-receipt-at" type="datetime-local" value={at} aria-invalid={atMessage !== undefined || undefined} aria-describedby={atMessage === undefined ? undefined : 'posting-receipt-at-error'} onChange={(event) => { setAt(event.target.value); setErrors({}); send.clear(); }} />
          <span className="sub">{t('egp.posting.receipt.at.hint')}</span>
          {atMessage !== undefined && (
            <span className="posting-error" id="posting-receipt-at-error" role="alert">
              {atMessage}
            </span>
          )}
        </div>
        <Reload problem={send.problem} onClose={onClose} />
      </div>
    </ConfirmDialog>
  );
}

function ReasonDialog({ mode, row, onClose, onDone }: DialogProps & { mode: 'reject' | 'cancel' }) {
  const { t } = useTranslation();
  const reject = useRejectPosting();
  const cancel = useCancelPosting();
  const send = useSending();
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const min = mode === 'reject' ? MIN_REJECT_REASON : MIN_CANCEL_REASON;
  const pending = reject.isPending || cancel.isPending;
  const confirm = (reason?: string): void => {
    const text = reason ?? '';
    const found = reasonProblem(text, min);
    setProblem(found);
    if (found !== undefined || !send.begin()) return;
    const callbacks = {
      onSuccess: () => {
        send.end();
        onDone(mode === 'reject' ? t('egp.posting.success.rejected', { kind: kindLabel(t, row.kind), code: row.subjectCode }) : t('egp.posting.success.cancelled', { kind: kindLabel(t, row.kind), code: row.subjectCode }));
        onClose();
      },
      onError: send.fail,
    };
    if (mode === 'reject') reject.mutate({ id: row.id, version: row.version, reason: text.trim() }, callbacks);
    else cancel.mutate({ id: row.id, version: row.version, reason: text.trim() }, callbacks);
  };
  const error = problem === undefined ? (send.problem === undefined ? undefined : problemText(t, send.problem)) : invalidText(t, problem, min);
  return (
    <ConfirmDialog
      open
      title={mode === 'reject' ? t('egp.posting.reject.title') : t('egp.posting.cancel.title')}
      context={contextOf(t, row)}
      confirmLabel={mode === 'reject' ? t('egp.posting.reject.confirm.action') : t('egp.posting.cancel.confirm.action')}
      cancelLabel={t('egp.posting.dialog.cancel.action')}
      pending={pending}
      reason={{ label: t('egp.posting.dialog.reason.label'), required: true, minLength: min, hint: t('egp.posting.dialog.reason.hint', { min }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <p className="sub">{mode === 'reject' ? t('egp.posting.reject.effect') : t('egp.posting.cancel.effect')}</p>
      <Reload problem={send.problem} onClose={onClose} />
    </ConfirmDialog>
  );
}

function OpenDialog({ onClose, onDone }: { onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const open = useOpenPosting();
  const send = useSending();
  const [form, setForm] = useState<OpenForm>(EMPTY_OPEN);
  const [errors, setErrors] = useState<Partial<Record<'ourCode' | 'projectCode' | 'triggeredOn', FieldProblem>>>({});
  const change = <K extends keyof OpenForm>(key: K, value: OpenForm[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors({});
    send.clear();
  };
  const confirm = (): void => {
    const found = validateOpen(form, vietnamToday(new Date()));
    setErrors(found);
    if (Object.keys(found).length > 0 || !send.begin()) return;
    open.mutate(openBody(form), {
      onSuccess: () => {
        send.end();
        onDone(t('egp.posting.success.opened', { kind: kindLabel(t, form.kind), code: form.ourCode.trim() }));
        onClose();
      },
      onError: send.fail,
    });
  };
  const message = (field: 'ourCode' | 'projectCode' | 'triggeredOn'): string | undefined => (errors[field] === undefined ? named(t, send.problem, field) : invalidText(t, errors[field] as FieldProblem));
  const text = (field: 'ourCode' | 'projectCode', id: string, label: string, hint?: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={form[field]} maxLength={MAX_CODE + 20} autoComplete="off" aria-invalid={message(field) !== undefined || undefined} aria-describedby={message(field) === undefined ? undefined : `${id}-error`} onChange={(event) => change(field, event.target.value)} />
      {hint !== undefined && <span className="sub">{hint}</span>}
      {message(field) !== undefined && (
        <span className="posting-error" id={`${id}-error`}>
          {message(field)}
        </span>
      )}
    </div>
  );
  const summary = Object.keys(errors).length > 0 ? t('egp.posting.invalid.summary') : undefined;
  const generic = send.problem !== undefined && (send.problem.field === undefined || send.problem.kind === 'calendar') ? problemText(t, send.problem) : undefined;
  return (
    <ConfirmDialog
      open
      title={t('egp.posting.open.title')}
      context={[{ label: t('egp.posting.dialog.source.label'), value: t('egp.posting.dialog.source.value') }]}
      confirmLabel={t('egp.posting.open.confirm.action')}
      cancelLabel={t('egp.posting.dialog.cancel.action')}
      pending={open.isPending}
      {...(summary !== undefined ? { error: summary } : generic === undefined ? {} : { error: generic })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="posting-form">
        <p className="sub">{t('egp.posting.open.effect')}</p>
        <div className="field">
          <label htmlFor="posting-open-kind">{t('egp.posting.open.kind.label')}</label>
          <select id="posting-open-kind" value={form.kind} onChange={(event) => change('kind', event.target.value as PostingKind)}>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(t, kind)}
              </option>
            ))}
          </select>
        </div>
        {text('ourCode', 'posting-open-code', t('egp.posting.open.code.label'), subjectHint(t, form.kind))}
        {PACKAGE_KINDS.includes(form.kind) && text('projectCode', 'posting-open-project', t('egp.posting.open.project.label'), t('egp.posting.open.project.hint'))}
        <div className="field">
          <label htmlFor="posting-open-day">{t('egp.posting.open.day.label')}</label>
          <input id="posting-open-day" type="date" value={form.triggeredOn} aria-invalid={message('triggeredOn') !== undefined || undefined} aria-describedby={message('triggeredOn') === undefined ? undefined : 'posting-open-day-error'} onChange={(event) => change('triggeredOn', event.target.value)} />
          <span className="sub">{t('egp.posting.open.day.hint')}</span>
          {message('triggeredOn') !== undefined && (
            <span className="posting-error" id="posting-open-day-error">
              {message('triggeredOn')}
            </span>
          )}
        </div>
        <Reload problem={send.problem} onClose={onClose} />
      </div>
    </ConfirmDialog>
  );
}

function SweepDialog({ onClose, onDone }: { onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const sweep = useSweepPostings();
  const send = useSending();
  const [since, setSince] = useState('');
  const [error, setError] = useState<FieldProblem | undefined>(undefined);
  const confirm = (): void => {
    const found = validateSweep(since, vietnamToday(new Date()));
    setError(found.sinceOn);
    if (found.sinceOn !== undefined || !send.begin()) return;
    sweep.mutate(
      { sinceOn: since },
      {
        onSuccess: (result) => {
          send.end();
          onDone(result.truncated ? t('egp.posting.success.sweptMore', { opened: result.opened, existing: result.existing, since: instantDay(result.sinceOn) }) : t('egp.posting.success.swept', { opened: result.opened, existing: result.existing, since: instantDay(result.sinceOn) }));
          onClose();
        },
        onError: send.fail,
      },
    );
  };
  const message = error === undefined ? named(t, send.problem, 'sinceOn') : invalidText(t, error);
  const generic = send.problem !== undefined && (send.problem.field === undefined || send.problem.kind === 'calendar') ? problemText(t, send.problem) : undefined;
  return (
    <ConfirmDialog
      open
      title={t('egp.posting.sweep.title')}
      context={[{ label: t('egp.posting.dialog.source.label'), value: t('egp.posting.dialog.source.value') }]}
      confirmLabel={t('egp.posting.sweep.confirm.action')}
      cancelLabel={t('egp.posting.dialog.cancel.action')}
      pending={sweep.isPending}
      {...(error !== undefined ? { error: t('egp.posting.invalid.summary') } : generic === undefined ? {} : { error: generic })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="posting-form">
        <p className="sub">{t('egp.posting.sweep.effect')}</p>
        <div className="field">
          <label htmlFor="posting-sweep-since">{t('egp.posting.sweep.since.label')}</label>
          <input id="posting-sweep-since" type="date" value={since} aria-invalid={message !== undefined || undefined} aria-describedby={message === undefined ? undefined : 'posting-sweep-since-error'} onChange={(event) => { setSince(event.target.value); setError(undefined); send.clear(); }} />
          <span className="sub">{t('egp.posting.sweep.since.hint')}</span>
          {message !== undefined && (
            <span className="posting-error" id="posting-sweep-since-error">
              {message}
            </span>
          )}
        </div>
        <Reload problem={send.problem} onClose={onClose} />
      </div>
    </ConfirmDialog>
  );
}
