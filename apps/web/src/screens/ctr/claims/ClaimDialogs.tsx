import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from './components';
import { describeProblem, formProblemText, textProblem, todayInVietnam, vnd } from './common';
import type { Problem } from './common';
import { useDeclareBar, useDecideSettlement, useLinkClaim, useRecordStep, useReloadRegisters } from './hooks';
import { decisionLabel, stepLabel } from './labels';
import { DECISIONS, MAX_TEXT, MIN_TEXT, emptyStep, linksBody, stepBody, validateLinks, validateStep } from './model';
import type { Claim, FormErrors, LinkForm, RecordableStep, StepForm } from './model';
import { RegisterDialog } from './RegisterDialog';

export type ClaimDialog =
  | { kind: 'step'; step: RecordableStep }
  | { kind: 'settlement'; decision: 'APPROVE' | 'REJECT' }
  | { kind: 'bar' }
  | { kind: 'links' };

export interface ClaimDialogsProps {
  claim: Claim;
  dialog: ClaimDialog;
  onClose: () => void;
  /** Called after a command succeeded, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

const contextOf = (t: ReturnType<typeof useTranslation>['t'], claim: Claim): Array<{ label: string; value: string }> => [
  { label: t('ctrClaim.dialog.claim.label'), value: `${claim.code} · ${claim.title}` },
  { label: t('ctrClaim.dialog.contract.label'), value: claim.contract.code },
];

/** The dialogs of the commands on a claim: each names the claim and the effect, asks for the words, locks while it sends and says in place why a command was refused. */
export function ClaimDialogs({ claim, dialog, onClose, onDone }: ClaimDialogsProps) {
  if (dialog.kind === 'step') return <StepDialog key={`step:${dialog.step}`} claim={claim} step={dialog.step} onClose={onClose} onDone={onDone} />;
  if (dialog.kind === 'settlement') return <SettlementDialog key={`settlement:${dialog.decision}`} claim={claim} decision={dialog.decision} onClose={onClose} onDone={onDone} />;
  if (dialog.kind === 'bar') return <BarDialog claim={claim} onClose={onClose} onDone={onDone} />;
  return <LinksDialog claim={claim} onClose={onClose} onDone={onDone} />;
}

function useSender() {
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const reload = useReloadRegisters();
  return {
    problem,
    reload: () => void reload(),
    clear: () => setProblem(undefined),
    run: (start: (handlers: { onSuccess: () => void; onError: (error: unknown) => void }) => void, done: () => void): void => {
      if (sending.current) return;
      sending.current = true;
      setProblem(undefined);
      start({
        onSuccess: () => {
          sending.current = false;
          done();
        },
        onError: (error) => {
          sending.current = false;
          setProblem(describeProblem(error));
        },
      });
    },
  };
}

function StepDialog({ claim, step, onClose, onDone }: { claim: Claim; step: RecordableStep; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const today = todayInVietnam();
  const record = useRecordStep();
  const sender = useSender();
  const [form, setForm] = useState<StepForm>(emptyStep(step, today));
  const [errors, setErrors] = useState<FormErrors<StepForm>>({});
  const set = (patch: Partial<StepForm>): void => setForm((current) => ({ ...current, ...patch }));
  const message = (field: keyof StepForm): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : formProblemText(t, found);
  };
  const submit = (note: string): void => {
    const next = { ...form, note };
    const found = validateStep(next, claim, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sender.run(
      (handlers) => record.mutate({ id: claim.id, version: claim.version, body: stepBody(next) }, handlers),
      () => onDone(t('ctrClaim.success.step.text', { step: stepLabel(t, step), code: claim.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrClaim.stepDialog.title', { step: stepLabel(t, step) })}
      context={contextOf(t, claim)}
      confirmLabel={t('ctrClaim.stepDialog.confirm.action')}
      note={{ label: t('ctrClaim.stepDialog.note.label'), hint: t('ctrClaim.stepDialog.note.hint'), minLength: MIN_TEXT }}
      pending={record.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrClaim.stepDialog.effect.text')}</p>
      <Field id="step-day" label={t('ctrClaim.stepDialog.occurredOn.label')} hint={t('ctrClaim.stepDialog.occurredOn.hint')} error={message('occurredOn')}>
        <input id="step-day" type="date" value={form.occurredOn} max={today} onChange={(event) => set({ occurredOn: event.target.value })} />
      </Field>
      {step === 'RESPONSE' && (
        <Field id="step-decision" label={t('ctrClaim.stepDialog.decision.label')} error={message('decision')}>
          <select id="step-decision" value={form.decision} onChange={(event) => set({ decision: event.target.value })}>
            <option value="">{t('ctrClaim.stepDialog.pick.option')}</option>
            {DECISIONS.map((decision) => (
              <option key={decision} value={decision}>
                {decisionLabel(t, decision)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {step === 'PARTICULARS' && (
        <>
          <Field id="step-claimed-amount" label={t('ctrClaim.stepDialog.claimedAmount.label')} error={message('claimedAmount')}>
            <input id="step-claimed-amount" type="text" inputMode="numeric" value={form.claimedAmount} onChange={(event) => set({ claimedAmount: event.target.value })} />
          </Field>
          <Field id="step-claimed-days" label={t('ctrClaim.stepDialog.claimedDays.label')} error={message('claimedDays')}>
            <input id="step-claimed-days" type="text" inputMode="numeric" value={form.claimedDays} onChange={(event) => set({ claimedDays: event.target.value })} />
          </Field>
        </>
      )}
      {step === 'SETTLEMENT_PROPOSAL' && (
        <>
          <p className="sub">{t('ctrClaim.stepDialog.settlement.hint')}</p>
          <Field id="step-settled-amount" label={t('ctrClaim.stepDialog.settledAmount.label')} error={message('settledAmount')}>
            <input id="step-settled-amount" type="text" inputMode="numeric" value={form.settledAmount} onChange={(event) => set({ settledAmount: event.target.value })} />
          </Field>
          <Field id="step-granted-days" label={t('ctrClaim.stepDialog.grantedDays.label')} error={message('grantedDays')}>
            <input id="step-granted-days" type="text" inputMode="numeric" value={form.grantedDays} onChange={(event) => set({ grantedDays: event.target.value })} />
          </Field>
        </>
      )}
    </RegisterDialog>
  );
}

function SettlementDialog({ claim, decision, onClose, onDone }: { claim: Claim; decision: 'APPROVE' | 'REJECT'; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t, locale } = useTranslation();
  const decide = useDecideSettlement();
  const sender = useSender();
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const submit = (note: string): void => {
    const problem = textProblem(note, MIN_TEXT, MAX_TEXT);
    setNoteError(problem === undefined ? undefined : formProblemText(t, problem));
    if (problem !== undefined) return;
    sender.run(
      (handlers) => decide.mutate({ id: claim.id, version: claim.version, body: { decision, note: note.trim() } }, handlers),
      () => onDone(decision === 'APPROVE' ? t('ctrClaim.success.settled.text', { code: claim.code }) : t('ctrClaim.success.settlementRejected.text', { code: claim.code })),
    );
  };
  return (
    <RegisterDialog
      title={decision === 'APPROVE' ? t('ctrClaim.settlementDialog.approve.title') : t('ctrClaim.settlementDialog.reject.title')}
      context={[
        ...contextOf(t, claim),
        ...(claim.settlement_proposed_by_name === null ? [] : [{ label: t('ctrClaim.dialog.proposedBy.label'), value: claim.settlement_proposed_by_name }]),
        ...(claim.settled_amount_vnd === null ? [] : [{ label: t('ctrClaim.dialog.settledAmount.label'), value: vnd(claim.settled_amount_vnd, locale) }]),
        ...(claim.granted_days === null ? [] : [{ label: t('ctrClaim.dialog.grantedDays.label'), value: String(claim.granted_days) }]),
      ]}
      confirmLabel={decision === 'APPROVE' ? t('ctrClaim.settlementDialog.approve.action') : t('ctrClaim.settlementDialog.reject.action')}
      note={{ label: t('ctrClaim.settlementDialog.note.label'), hint: t('ctrClaim.settlementDialog.note.hint'), minLength: MIN_TEXT }}
      pending={decide.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{decision === 'APPROVE' ? t('ctrClaim.settlementDialog.approve.effect') : t('ctrClaim.settlementDialog.reject.effect')}</p>
      <p className="sub" data-testid="four-eyes-note">
        {t('ctrClaim.settlementDialog.fourEyes.text')}
      </p>
      {noteError !== undefined && (
        <small role="alert" className="field-error">
          {noteError}
        </small>
      )}
    </RegisterDialog>
  );
}

function BarDialog({ claim, onClose, onDone }: { claim: Claim; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const bar = useDeclareBar();
  const sender = useSender();
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const submit = (note: string): void => {
    const problem = textProblem(note, MIN_TEXT, MAX_TEXT);
    setNoteError(problem === undefined ? undefined : formProblemText(t, problem));
    if (problem !== undefined) return;
    sender.run(
      (handlers) => bar.mutate({ id: claim.id, version: claim.version, body: { reason: note.trim() } }, handlers),
      () => onDone(t('ctrClaim.success.barred.text', { code: claim.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrClaim.barDialog.title')}
      context={[...contextOf(t, claim), { label: t('ctrClaim.dialog.registeredBy.label'), value: claim.registered_by_name ?? '–' }]}
      confirmLabel={t('ctrClaim.barDialog.confirm.action')}
      note={{ label: t('ctrClaim.barDialog.reason.label'), hint: t('ctrClaim.barDialog.reason.hint'), minLength: MIN_TEXT }}
      pending={bar.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrClaim.barDialog.effect.text')}</p>
      <p className="sub" data-testid="four-eyes-note">
        {t('ctrClaim.barDialog.fourEyes.text')}
      </p>
      {noteError !== undefined && (
        <small role="alert" className="field-error">
          {noteError}
        </small>
      )}
    </RegisterDialog>
  );
}

function LinksDialog({ claim, onClose, onDone }: { claim: Claim; onClose: () => void; onDone: (receipt: string) => void }) {
  const { t } = useTranslation();
  const link = useLinkClaim();
  const sender = useSender();
  const [form, setForm] = useState<LinkForm>({ changeRequestId: claim.change_request?.id ?? '', paymentRequestId: claim.payment_request?.id ?? '' });
  const [errors, setErrors] = useState<FormErrors<LinkForm>>({});
  const message = (field: keyof LinkForm): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : formProblemText(t, found);
  };
  const submit = (): void => {
    const found = validateLinks(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sender.run(
      (handlers) => link.mutate({ id: claim.id, version: claim.version, body: linksBody(form) }, handlers),
      () => onDone(t('ctrClaim.success.linked.text', { code: claim.code })),
    );
  };
  return (
    <RegisterDialog
      title={t('ctrClaim.linksDialog.title')}
      context={contextOf(t, claim)}
      confirmLabel={t('ctrClaim.linksDialog.confirm.action')}
      pending={link.isPending}
      problem={sender.problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={sender.reload}
    >
      <p className="sub">{t('ctrClaim.linksDialog.effect.text')}</p>
      <Field id="link-change" label={t('ctrClaim.linksDialog.change.label')} hint={t('ctrClaim.linksDialog.change.hint')} error={message('changeRequestId')}>
        <input id="link-change" type="text" value={form.changeRequestId} onChange={(event) => setForm({ ...form, changeRequestId: event.target.value })} />
      </Field>
      <Field id="link-payment" label={t('ctrClaim.linksDialog.payment.label')} hint={t('ctrClaim.linksDialog.payment.hint')} error={message('paymentRequestId')}>
        <input id="link-payment" type="text" value={form.paymentRequestId} onChange={(event) => setForm({ ...form, paymentRequestId: event.target.value })} />
      </Field>
    </RegisterDialog>
  );
}
