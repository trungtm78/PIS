import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from './components';
import { describeProblem, formProblemText } from './common';
import type { Problem } from './common';
import { useDecideTerm, useProposeTerm, useReloadRegisters } from './hooks';
import { basisLabel, effectHint, effectLabel, particularsFromLabel, sideLabel } from './labels';
import { BASES, EFFECTS, MIN_TEXT, SIDES, emptyTerm, termBody, validateTerm } from './model';
import type { ClaimTerm, FormErrors, Side, TermForm } from './model';
import { RegisterDialog } from './RegisterDialog';

export type TermDialog = { kind: 'propose'; form: TermForm; nonce: number } | { kind: 'decide'; term: ClaimTerm; decision: 'APPROVE' | 'REJECT' };

export interface TermDialogsProps {
  contract: { id: string; code: string };
  dialog: TermDialog;
  onClose: () => void;
  onDone: (receipt: string) => void;
}

export function TermDialogs({ contract, dialog, onClose, onDone }: TermDialogsProps) {
  if (dialog.kind === 'propose') return <ProposeDialog key={dialog.nonce} contract={contract} initial={dialog.form} onClose={onClose} onDone={onDone} />;
  return <DecideDialog key={`${dialog.term.id}:${dialog.decision}`} contract={contract} term={dialog.term} decision={dialog.decision} onClose={onClose} onDone={onDone} />;
}

function ProposeDialog({ contract, initial, onClose, onDone }: { contract: { id: string; code: string }; initial: TermForm; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const propose = useProposeTerm();
  const reload = useReloadRegisters();
  const [form, setForm] = useState<TermForm>(initial);
  const [errors, setErrors] = useState<FormErrors<TermForm>>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const set = (patch: Partial<TermForm>): void => setForm((current) => ({ ...current, ...patch }));
  const message = (field: keyof TermForm): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : formProblemText(t, found);
  };
  const submit = (): void => {
    if (sending.current) return;
    const found = validateTerm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sending.current = true;
    setProblem(undefined);
    propose.mutate(
      { contractId: contract.id, body: termBody(form) },
      {
        onSuccess: () => {
          sending.current = false;
          onDone(t('ctrClaim.terms.success.proposed.text', { contract: contract.code, side: sideLabel(t, form.side) }));
        },
        onError: (error) => {
          sending.current = false;
          setProblem(describeProblem(error));
        },
      },
    );
  };
  const period = (id: string, field: 'noticeDays' | 'particularsDays' | 'responseDays' | 'settlementDays', label: string) => (
    <Field id={id} label={label} error={message(field)}>
      <input id={id} type="text" inputMode="numeric" value={form[field]} onChange={(event) => set({ [field]: event.target.value })} />
    </Field>
  );
  return (
    <RegisterDialog
      title={t('ctrClaim.terms.propose.title')}
      context={[
        { label: t('ctrClaim.terms.contract.label'), value: contract.code },
        ...(form.templateCode === '' ? [] : [{ label: t('ctrClaim.terms.propose.template.label'), value: form.templateCode }]),
      ]}
      confirmLabel={t('ctrClaim.terms.propose.confirm.action')}
      pending={propose.isPending}
      problem={problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={() => void reload()}
    >
      <p className="sub">{t('ctrClaim.terms.propose.effect.text')}</p>
      {form.templateCode !== '' && (
        <p className="ctrreg-notice" role="status" data-testid="template-notice">
          {t('ctrClaim.terms.propose.templateNotice.text')}
        </p>
      )}
      <Field id="term-side" label={t('ctrClaim.terms.side.label')} error={undefined}>
        <select id="term-side" value={form.side} onChange={(event) => set({ side: event.target.value as Side })}>
          {SIDES.map((side) => (
            <option key={side} value={side}>
              {sideLabel(t, side)}
            </option>
          ))}
        </select>
      </Field>
      {period('term-notice', 'noticeDays', t('ctrClaim.terms.noticeDays.label'))}
      {period('term-particulars', 'particularsDays', t('ctrClaim.terms.particularsDays.label'))}
      {period('term-response', 'responseDays', t('ctrClaim.terms.responseDays.label'))}
      {period('term-settlement', 'settlementDays', t('ctrClaim.terms.settlementDays.label'))}
      <Field id="term-basis" label={t('ctrClaim.terms.basis.label')} error={undefined}>
        <select id="term-basis" value={form.basis} onChange={(event) => set({ basis: event.target.value as TermForm['basis'] })}>
          {BASES.map((basis) => (
            <option key={basis} value={basis}>
              {basisLabel(t, basis)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="term-from" label={t('ctrClaim.terms.particularsFrom.label')} error={message('particularsFrom')}>
        <select id="term-from" value={form.particularsFrom} onChange={(event) => set({ particularsFrom: event.target.value as TermForm['particularsFrom'] })}>
          {(['AWARENESS', 'NOTICE'] as const).map((from) => (
            <option key={from} value={from}>
              {particularsFromLabel(t, from)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="term-effect" label={t('ctrClaim.terms.barEffect.label')} hint={effectHint(t, form.barEffect)} error={message('barEffect')}>
        <select id="term-effect" value={form.barEffect} onChange={(event) => set({ barEffect: event.target.value as TermForm['barEffect'] })}>
          {EFFECTS.map((effect) => (
            <option key={effect} value={effect}>
              {effectLabel(t, effect)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="term-clause" label={t('ctrClaim.terms.clause.label')} hint={t('ctrClaim.terms.clause.hint')} error={message('clause')}>
        <input id="term-clause" type="text" value={form.clause} onChange={(event) => set({ clause: event.target.value })} />
      </Field>
    </RegisterDialog>
  );
}

function DecideDialog({ contract, term, decision, onClose, onDone }: { contract: { id: string; code: string }; term: ClaimTerm; decision: 'APPROVE' | 'REJECT'; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const decide = useDecideTerm();
  const reload = useReloadRegisters();
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const submit = (note: string): void => {
    if (sending.current) return;
    sending.current = true;
    setProblem(undefined);
    decide.mutate(
      { id: term.id, version: term.version, body: { decision, ...(note.trim() === '' ? {} : { note: note.trim() }) } },
      {
        onSuccess: () => {
          sending.current = false;
          onDone(decision === 'APPROVE' ? t('ctrClaim.terms.success.approved.text', { contract: contract.code }) : t('ctrClaim.terms.success.rejected.text', { contract: contract.code }));
        },
        onError: (error) => {
          sending.current = false;
          setProblem(describeProblem(error));
        },
      },
    );
  };
  return (
    <RegisterDialog
      title={decision === 'APPROVE' ? t('ctrClaim.terms.approve.title') : t('ctrClaim.terms.reject.title')}
      context={[
        { label: t('ctrClaim.terms.contract.label'), value: contract.code },
        { label: t('ctrClaim.terms.side.label'), value: sideLabel(t, term.claimant_side) },
        { label: t('ctrClaim.terms.clause.label'), value: term.clause_reference },
        ...(term.proposed_by_name === null ? [] : [{ label: t('ctrClaim.terms.proposedBy.label'), value: term.proposed_by_name }]),
      ]}
      confirmLabel={decision === 'APPROVE' ? t('ctrClaim.terms.approve.confirm.action') : t('ctrClaim.terms.reject.confirm.action')}
      {...(decision === 'REJECT' ? { note: { label: t('ctrClaim.terms.reject.note.label'), minLength: MIN_TEXT } } : {})}
      pending={decide.isPending}
      problem={problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={() => void reload()}
    >
      <p className="sub">{decision === 'APPROVE' ? t('ctrClaim.terms.approve.effect.text') : t('ctrClaim.terms.reject.effect.text')}</p>
      <p className="sub" data-testid="four-eyes-note">
        {t('ctrClaim.terms.fourEyes.text')}
      </p>
    </RegisterDialog>
  );
}

export const proposeDialog = (nonce: number, form: TermForm = emptyTerm()): TermDialog => ({ kind: 'propose', form, nonce });
