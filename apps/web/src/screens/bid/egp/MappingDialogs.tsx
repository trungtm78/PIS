import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { useDecide, usePropose, useReload, useRetire } from './mapping-hooks';
import { findingText, invalidText, problemText, subjectLabel } from './mapping-labels';
import { MAX_CODE, MIN_REASON, SUBJECT_TYPES, describeProblem, dayText, isPackageLike, likenessText, proposeBody, validatePropose } from './mapping-model';
import type { FormErrors, MappingRow, Problem, ProposeField, ProposeForm, SubjectType } from './mapping-model';
import './mapping.css';

type T = Translator['t'];

export type MappingDialog =
  | { kind: 'propose'; form: ProposeForm; nonce: number }
  | { kind: 'decide'; row: MappingRow; decision: 'APPROVE' | 'REJECT' }
  | { kind: 'retire'; row: MappingRow };

export interface MappingDialogsProps {
  dialog: MappingDialog | undefined;
  onClose: () => void;
  /** Called after a command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

const ourCodeOf = (t: T, row: MappingRow): string => (row.ourCode === null ? t('egp.mapping.cell.noOurCode') : row.projectCode === null ? row.ourCode : `${row.ourCode} (${t('egp.mapping.cell.project', { code: row.projectCode })})`);
const validityOf = (t: T, row: MappingRow): string => t('egp.mapping.cell.validity', { from: dayText(row.validFrom), until: row.validUntil === null ? t('egp.mapping.cell.unlimited') : dayText(row.validUntil) });

/** The dialogs of the commands of BID-23: each names the record and the effect, asks for the reason, locks while it sends and says in place why it was refused. */
export function MappingDialogs({ dialog, onClose, onDone }: MappingDialogsProps) {
  if (dialog === undefined) return null;
  if (dialog.kind === 'propose') return <ProposeDialog key={dialog.nonce} initial={dialog.form} onClose={onClose} onDone={onDone} />;
  return <RowDialog key={`${dialog.kind}:${dialog.row.id}`} dialog={dialog} onClose={onClose} onDone={onDone} />;
}

/** A refusal said in the dialog; a version conflict also offers the reload. */
function Refusal({ problem, onReload }: { problem: Problem; onReload: () => void }): ReactNode {
  const { t } = useTranslation();
  return (
    <>
      {problem.kind === 'validation' && problem.findings.length > 0 && (
        <ul className="mapping-findings" aria-label={t('egp.mapping.problem.findings.label')}>
          {problem.findings.map((finding, index) => (
            <li key={`${finding.code}:${index}`}>{findingText(t, finding.code)}</li>
          ))}
        </ul>
      )}
      {problem.kind === 'versionConflict' && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload}>
          {t('egp.mapping.problem.reload.action')}
        </button>
      )}
    </>
  );
}

function RowDialog({ dialog, onClose, onDone }: { dialog: Exclude<MappingDialog, { kind: 'propose' }>; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const decide = useDecide();
  const retire = useRetire();
  const reload = useReload();
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const row = dialog.row;
  const pending = decide.isPending || retire.isPending;
  const context = [
    { label: t('egp.mapping.column.subject'), value: subjectLabel(t, row.subjectType) },
    { label: t('egp.mapping.column.ours'), value: ourCodeOf(t, row) },
    { label: t('egp.mapping.column.external'), value: row.externalCode },
    { label: t('egp.mapping.column.validity'), value: validityOf(t, row) },
    ...(row.proposedByName === null ? [] : [{ label: t('egp.mapping.dialog.proposedBy.label'), value: row.proposedByName }]),
  ];
  const fail = (error: unknown): void => {
    sending.current = false;
    setProblem(describeProblem(error));
  };
  const done = (receipt: string): void => {
    sending.current = false;
    onDone(receipt);
    onClose();
  };
  const reason = { label: t('egp.mapping.dialog.reason.label'), required: true, minLength: MIN_REASON, hint: t('egp.mapping.dialog.reason.hint') };
  const common = {
    open: true,
    context,
    cancelLabel: t('egp.mapping.dialog.cancel.action'),
    pending,
    reason,
    onCancel: onClose,
    ...(problem === undefined ? {} : { error: problemText(t, problem) }),
  };
  const refusal = problem === undefined ? null : <Refusal problem={problem} onReload={() => { void reload(); onClose(); }} />;
  const send = (run: (text: string) => void) => (text?: string): void => {
    if (sending.current) return;
    sending.current = true;
    setProblem(undefined);
    run(text ?? '');
  };
  const codes = { code: row.ourCode ?? row.externalCode, external: row.externalCode };

  if (dialog.kind === 'retire') {
    return (
      <ConfirmDialog
        {...common}
        title={t('egp.mapping.retire.title')}
        confirmLabel={t('egp.mapping.retire.confirm.action')}
        onConfirm={send((text) => retire.mutate({ id: row.id, version: row.version, reason: text }, { onSuccess: () => done(t('egp.mapping.success.retired', codes)), onError: fail }))}
      >
        <p className="sub">{t('egp.mapping.retire.effect')}</p>
        {refusal}
      </ConfirmDialog>
    );
  }
  const approve = dialog.decision === 'APPROVE';
  return (
    <ConfirmDialog
      {...common}
      title={approve ? t('egp.mapping.approve.title') : t('egp.mapping.reject.title')}
      confirmLabel={approve ? t('egp.mapping.approve.confirm.action') : t('egp.mapping.reject.confirm.action')}
      onConfirm={send((text) =>
        decide.mutate(
          { id: row.id, version: row.version, decision: dialog.decision, reason: text },
          { onSuccess: () => done(approve ? t('egp.mapping.success.approved', codes) : t('egp.mapping.success.rejected', codes)), onError: fail },
        ),
      )}
    >
      <p className="sub">{approve ? t('egp.mapping.approve.effect') : t('egp.mapping.reject.effect')}</p>
      <p className="sub">{t('egp.mapping.dialog.maker.note')}</p>
      {refusal}
    </ConfirmDialog>
  );
}

function ProposeDialog({ initial, onClose, onDone }: { initial: ProposeForm; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t, locale } = useTranslation();
  const propose = usePropose();
  const reload = useReload();
  const [form, setForm] = useState<ProposeForm>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  const suggested = initial.suggestionConfidence !== undefined;
  const contractor = form.subjectType === 'CONTRACTOR';

  // The dialog opens on its first field, not on the reason at its foot.
  useEffect(() => {
    const timer = setTimeout(() => wrap.current?.querySelector<HTMLElement>('input:not([readonly]):not([disabled]), select:not([disabled])')?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const change = <K extends keyof ProposeForm>(key: K, value: ProposeForm[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors({});
    setProblem(undefined);
  };
  const named = (field: ProposeField): string | undefined => {
    const own = errors[field];
    if (own !== undefined) return invalidText(t, own);
    return problem?.kind === 'validation' && problem.field === field ? problemText(t, problem) : undefined;
  };

  const text = (field: ProposeField, id: string, label: string, key: 'ourCode' | 'projectCode' | 'externalCode', options: { readOnly?: boolean; hint?: string } = {}) => {
    const message = named(field);
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input id={id} value={form[key]} readOnly={options.readOnly === true} maxLength={MAX_CODE + 20} aria-invalid={message !== undefined} aria-describedby={message === undefined ? undefined : `${id}-error`} autoComplete="off" onChange={(event) => change(key, event.target.value)} />
        {options.hint !== undefined && <span className="sub">{options.hint}</span>}
        {message !== undefined && (
          <span className="mapping-error" id={`${id}-error`}>
            {message}
          </span>
        )}
      </div>
    );
  };
  const day = (field: 'validFrom' | 'validUntil', id: string, label: string, hint?: string) => {
    const message = named(field);
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input id={id} type="date" value={form[field]} aria-invalid={message !== undefined} aria-describedby={message === undefined ? undefined : `${id}-error`} onChange={(event) => change(field, event.target.value)} />
        {hint !== undefined && <span className="sub">{hint}</span>}
        {message !== undefined && (
          <span className="mapping-error" id={`${id}-error`}>
            {message}
          </span>
        )}
      </div>
    );
  };

  const invalidSummary = Object.keys(errors).length > 0 ? t('egp.mapping.invalid.summary') : undefined;
  const methodMessage = named('method') ?? named('confidence');
  const error = invalidSummary ?? (problem === undefined ? undefined : problemText(t, problem));

  const confirm = (reason?: string): void => {
    if (sending.current) return;
    const found = validatePropose(form);
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length > 0) return;
    sending.current = true;
    propose.mutate(proposeBody(form, reason ?? ''), {
      onSuccess: () => {
        sending.current = false;
        onDone(t('egp.mapping.success.proposed', { code: form.ourCode.trim(), external: form.externalCode.trim() }));
        onClose();
      },
      onError: (failure) => {
        sending.current = false;
        setProblem(describeProblem(failure));
      },
    });
  };

  return (
    <ConfirmDialog
      open
      title={t('egp.mapping.propose.title')}
      context={[{ label: t('egp.mapping.dialog.source.label'), value: t('egp.mapping.dialog.source.value') }]}
      confirmLabel={t('egp.mapping.propose.confirm.action')}
      cancelLabel={t('egp.mapping.dialog.cancel.action')}
      pending={propose.isPending}
      reason={{ label: t('egp.mapping.propose.reason.label'), required: true, minLength: MIN_REASON, hint: t('egp.mapping.dialog.reason.hint') }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div ref={wrap} className="mapping-form">
        <p className="sub">{t('egp.mapping.propose.maker.note')}</p>
        {suggested && <p className="callout" data-testid="suggestion-note">{t('egp.mapping.propose.suggestion.note', { value: likenessText(initial.suggestionConfidence ?? 0, locale) })}</p>}
        {contractor && <p className="callout" data-testid="contractor-note">{t('egp.mapping.propose.contractor.note')}</p>}
        <div className="field">
          <label htmlFor="mapping-subject">{t('egp.mapping.field.subject.label')}</label>
          <select id="mapping-subject" value={form.subjectType} disabled={suggested} onChange={(event) => change('subjectType', event.target.value as SubjectType)}>
            {SUBJECT_TYPES.map((subject) => (
              <option key={subject} value={subject}>
                {subjectLabel(t, subject)}
              </option>
            ))}
          </select>
        </div>
        {text('ourCode', 'mapping-our-code', contractor ? t('egp.mapping.field.ourCode.contractor') : t('egp.mapping.field.ourCode.label'), 'ourCode', { readOnly: suggested })}
        {isPackageLike(form.subjectType) && text('projectCode', 'mapping-project-code', t('egp.mapping.field.projectCode.label'), 'projectCode', { hint: t('egp.mapping.field.projectCode.hint') })}
        {text('externalCode', 'mapping-external-code', t('egp.mapping.field.externalCode.label'), 'externalCode', { readOnly: suggested })}
        {day('validFrom', 'mapping-valid-from', t('egp.mapping.field.validFrom.label'), t('egp.mapping.field.validFrom.hint'))}
        {day('validUntil', 'mapping-valid-until', t('egp.mapping.field.validUntil.label'), t('egp.mapping.field.validUntil.hint'))}
        {methodMessage !== undefined && <p className="mapping-error">{methodMessage}</p>}
        {problem !== undefined && <Refusal problem={problem} onReload={() => { void reload(); onClose(); }} />}
      </div>
    </ConfirmDialog>
  );
}
