import { useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import type { ConfirmDialogProps } from '../../../ui';
import { useAdvance, useAssignItem, useAssignOwner, useCancel, useCompleteItem, useDecideException, useFilterOptions, useHold, useRequestException, useResume, useReturnStep, useStartWorkflow } from './hooks';
import { errorText, evidenceKindLabel, exceptionKindLabel, milestoneLabel, refusalBlocker } from './labels';
import { blockersOf, failureCode } from './model';
import type { ChecklistItemDto, DetailDto, ExceptionDto } from './model';

export type PackageDialog =
  | { kind: 'start' }
  | { kind: 'advance' }
  | { kind: 'return' }
  | { kind: 'hold' }
  | { kind: 'resume' }
  | { kind: 'cancel' }
  | { kind: 'owner' }
  | { kind: 'exception' }
  | { kind: 'decide'; exception: ExceptionDto; decision: 'APPROVE' | 'REJECT' }
  | { kind: 'complete'; item: ChecklistItemDto }
  | { kind: 'assignItem'; item: ChecklistItemDto };

/** A dialog that sends once: a second press before the answer is ignored (the button locks only after the next render, a double click is faster). */
function Guard({ sending, onConfirm, ...props }: ConfirmDialogProps & { sending: MutableRefObject<boolean> }) {
  return (
    <ConfirmDialog
      {...props}
      onConfirm={(reason) => {
        if (sending.current) return;
        sending.current = true;
        onConfirm(reason);
      }}
    />
  );
}

export interface PackageDialogsProps {
  detail: DetailDto;
  dialog: PackageDialog | undefined;
  onClose: () => void;
  /** Called after a command succeeded, with the key of the receipt line. */
  onDone: (receipt: { kind: PackageDialog['kind']; step?: string | undefined }) => void;
  onReload: () => void;
}

const KNOWN_KINDS = ['DOCUMENT', 'DECISION_DOCUMENT', 'MILESTONE', 'ATTESTATION', 'EXTERNAL_RECEIPT'] as const;

/** The dialogs of the commands of the package page: each names the record and the effect, asks for the reason where one is required, locks while it sends, and says in place why it was refused. */
export function PackageDialogs({ detail, dialog, onClose, onDone, onReload }: PackageDialogsProps) {
  const { t } = useTranslation();
  const workflow = detail.workflow;
  const owners = useFilterOptions('owners');
  const start = useStartWorkflow();
  const advance = useAdvance();
  const returned = useReturnStep();
  const hold = useHold();
  const resume = useResume();
  const cancel = useCancel();
  const assign = useAssignOwner();
  const request = useRequestException();
  const decide = useDecideException();
  const complete = useCompleteItem();
  const assignItem = useAssignItem();
  const [person, setPerson] = useState('');
  const [toStep, setToStep] = useState('');
  const [kind, setKind] = useState<'SKIP_ITEMS' | 'CORRECT_BACK'>('SKIP_ITEMS');
  const [useException, setUseException] = useState(true);
  const [evidenceKind, setEvidenceKind] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [lastError, setLastError] = useState<unknown>(undefined);
  const sending = useRef(false);

  if (dialog === undefined) return null;
  const context = [
    { label: t('prc1.dialog.package.label'), value: `${detail.package.code}${detail.package.title === null ? '' : ` · ${detail.package.title}`}` },
    ...(workflow?.step === null || workflow?.step === undefined ? [] : [{ label: t('prc1.dialog.step.label'), value: workflow.step.name ?? workflow.step.code }]),
  ];
  const finish = (step?: string): void => {
    sending.current = false;
    setLastError(undefined);
    setPerson('');
    setNote('');
    setReference('');
    onDone({ kind: dialog.kind, step });
    onClose();
  };
  const fail = (error: unknown): void => {
    sending.current = false;
    setLastError(error);
  };
  const close = (): void => {
    sending.current = false;
    setLastError(undefined);
    onClose();
  };
  const refusal = (): string | undefined => (lastError === undefined ? undefined : errorText(t, lastError));
  const blockers = blockersOf(lastError);
  const extra = (
    <>
      {failureCode(lastError) === 'VERSION_CONFLICT' && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => { setLastError(undefined); onReload(); onClose(); }}>
          {t('prc1.dialog.reload.action')}
        </button>
      )}
      {blockers.length > 0 && (
        <ul className="prc1-list" aria-label={t('prc1.dialog.blockers.label')}>
          {blockers.map((blocker) => (
            <li key={`${blocker.code}:${blocker.subject ?? ''}`}>{refusalBlocker(t, blocker.code, blocker.subject)}</li>
          ))}
        </ul>
      )}
    </>
  );
  const memberSelect = (id: string, required: boolean) => (
    <div className="field">
      <label htmlFor={id}>{t('prc1.dialog.owner.label')}</label>
      <select id={id} value={person} onChange={(event) => setPerson(event.target.value)} required={required}>
        <option value="">{t('prc1.dialog.owner.choose')}</option>
        {(owners.data ?? []).map((one) => (
          <option key={one.id} value={one.id}>
            {one.name}
          </option>
        ))}
      </select>
    </div>
  );
  const version = workflow?.version ?? 0;
  const workflowId = workflow?.id ?? '';

  switch (dialog.kind) {
    case 'start':
      return (
        <Guard sending={sending} open title={t('prc1.dialog.start.title')} context={context} confirmLabel={t('prc1.dialog.start.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={start.isPending} error={refusal()} onCancel={close}
          onConfirm={() => start.mutate({ packageId: detail.package.id, ownerId: person === '' ? undefined : person }, { onSuccess: () => finish(detail.definition_steps?.[0]?.name), onError: fail })}>
          <p className="sub">{t('prc1.dialog.start.text', { count: detail.definition_steps?.length ?? 0 })}</p>
          {memberSelect('prc1-start-owner', false)}
          {extra}
        </Guard>
      );
    case 'advance': {
      const approved = workflow?.exceptions.find((one) => one.kind === 'SKIP_ITEMS' && one.status === 'APPROVED' && one.step_code === workflow.step?.code);
      const next = workflow?.steps.find((one) => one.order === (workflow.progress.current_order ?? 0) + 1);
      return (
        <Guard sending={sending} open title={t('prc1.dialog.advance.title')} context={[...context, { label: t('prc1.dialog.next.label'), value: next?.name ?? t('prc1.dialog.next.end') }]} confirmLabel={t('prc1.dialog.advance.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={advance.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.note.label') }}
          onConfirm={(text) => advance.mutate({ workflowId, version, ...(text === undefined || text === '' ? {} : { note: text }), ...(approved !== undefined && useException ? { exceptionId: approved.id } : {}) }, { onSuccess: () => finish(next?.name), onError: fail })}>
          {approved !== undefined && (
            <label className="checkbox">
              <input type="checkbox" checked={useException} onChange={(event) => setUseException(event.target.checked)} /> {t('prc1.dialog.useException.label')}
            </label>
          )}
          {extra}
        </Guard>
      );
    }
    case 'return': {
      const earlier = (workflow?.steps ?? []).filter((one) => one.order < (workflow?.progress.current_order ?? 0));
      return (
        <Guard sending={sending} open title={t('prc1.dialog.return.title')} context={context} confirmLabel={t('prc1.dialog.return.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={returned.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.reason.label'), required: true, minLength: 5, hint: t('prc1.dialog.reason.hint') }}
          onConfirm={(text) => returned.mutate({ workflowId, version, toStep: toStep === '' ? (earlier[earlier.length - 1]?.code ?? '') : toStep, reason: text ?? '' }, { onSuccess: () => finish(), onError: fail })}>
          <div className="field">
            <label htmlFor="prc1-return-step">{t('prc1.dialog.returnTo.label')}</label>
            <select id="prc1-return-step" value={toStep === '' ? (earlier[earlier.length - 1]?.code ?? '') : toStep} onChange={(event) => setToStep(event.target.value)}>
              {earlier.map((one) => (
                <option key={one.code} value={one.code}>
                  {one.name}
                </option>
              ))}
            </select>
          </div>
          {extra}
        </Guard>
      );
    }
    case 'hold':
      return (
        <Guard sending={sending} open title={t('prc1.dialog.hold.title')} context={context} confirmLabel={t('prc1.dialog.hold.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={hold.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.reason.label'), required: true, minLength: 5, hint: t('prc1.dialog.reason.hint') }}
          onConfirm={(text) => hold.mutate({ workflowId, version, reason: text ?? '' }, { onSuccess: () => finish(), onError: fail })}>
          {extra}
        </Guard>
      );
    case 'resume':
      return (
        <Guard sending={sending} open title={t('prc1.dialog.resume.title')} context={context} confirmLabel={t('prc1.dialog.resume.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={resume.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.note.label') }}
          onConfirm={(text) => resume.mutate({ workflowId, version, ...(text === undefined || text === '' ? {} : { note: text }) }, { onSuccess: () => finish(), onError: fail })}>
          <p className="sub">{t('prc1.dialog.resume.text')}</p>
          {extra}
        </Guard>
      );
    case 'cancel':
      return (
        <Guard sending={sending} open title={t('prc1.dialog.cancel.title')} context={context} confirmLabel={t('prc1.dialog.cancel.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={cancel.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.reason.label'), required: true, minLength: 5, hint: t('prc1.dialog.reason.hint') }}
          onConfirm={(text) => cancel.mutate({ workflowId, version, reason: text ?? '' }, { onSuccess: () => finish(), onError: fail })}>
          <p className="sub">{t('prc1.dialog.cancel.text')}</p>
          {extra}
        </Guard>
      );
    case 'owner': {
      const reassign = workflow?.owner !== null && workflow?.owner !== undefined;
      return (
        <Guard sending={sending} open title={reassign ? t('prc1.dialog.reassign.title') : t('prc1.dialog.assign.title')} context={context} confirmLabel={t('prc1.dialog.assign.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={assign.isPending} error={refusal()} onCancel={close}
          reason={reassign ? { label: t('prc1.dialog.reason.label'), required: true, minLength: 5, hint: t('prc1.dialog.reason.hint') } : { label: t('prc1.dialog.note.label') }}
          onConfirm={(text) => { if (person === '') return; assign.mutate({ workflowId, version, ownerId: person, ...(text === undefined || text === '' ? {} : { reason: text }) }, { onSuccess: () => finish(), onError: fail }); }}>
          {memberSelect('prc1-owner', true)}
          {extra}
        </Guard>
      );
    }
    case 'exception':
      return (
        <Guard sending={sending} open title={t('prc1.dialog.exception.title')} context={context} confirmLabel={t('prc1.dialog.exception.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={request.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.reason.label'), required: true, minLength: 5, hint: t('prc1.dialog.reason.hint') }}
          onConfirm={(text) => request.mutate({ workflowId, kind, reason: text ?? '' }, { onSuccess: () => finish(), onError: fail })}>
          <div className="field">
            <label htmlFor="prc1-exception-kind">{t('prc1.dialog.exceptionKind.label')}</label>
            <select id="prc1-exception-kind" value={kind} onChange={(event) => setKind(event.target.value === 'CORRECT_BACK' ? 'CORRECT_BACK' : 'SKIP_ITEMS')}>
              <option value="SKIP_ITEMS">{exceptionKindLabel(t, 'SKIP_ITEMS')}</option>
              <option value="CORRECT_BACK">{exceptionKindLabel(t, 'CORRECT_BACK')}</option>
            </select>
          </div>
          <p className="sub">{t('prc1.dialog.exception.text')}</p>
          {extra}
        </Guard>
      );
    case 'decide':
      return (
        <Guard sending={sending} open title={dialog.decision === 'APPROVE' ? t('prc1.dialog.approve.title') : t('prc1.dialog.reject.title')} context={[...context, { label: t('prc1.dialog.exceptionKind.label'), value: exceptionKindLabel(t, dialog.exception.kind) }, { label: t('prc1.dialog.reason.label'), value: dialog.exception.reason }]} confirmLabel={dialog.decision === 'APPROVE' ? t('prc1.dialog.approve.confirm') : t('prc1.dialog.reject.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={decide.isPending} error={refusal()} onCancel={close}
          reason={{ label: t('prc1.dialog.note.label') }}
          onConfirm={(text) => decide.mutate({ exceptionId: dialog.exception.id, decision: dialog.decision, ...(text === undefined || text === '' ? {} : { note: text }) }, { onSuccess: () => finish(), onError: fail })}>
          {extra}
        </Guard>
      );
    case 'assignItem':
      return (
        <Guard sending={sending} open title={t('prc1.dialog.assignItem.title')} context={[...context, { label: t('prc1.dialog.item.label'), value: dialog.item.name }]} confirmLabel={t('prc1.dialog.assign.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={assignItem.isPending} error={refusal()} onCancel={close}
          onConfirm={() => { if (person === '') return; assignItem.mutate({ itemId: dialog.item.id, ownerId: person }, { onSuccess: () => finish(), onError: fail }); }}>
          {memberSelect('prc1-item-owner', true)}
          {extra}
        </Guard>
      );
    case 'complete': {
      const allowed = dialog.item.allowed_kinds.length > 0 ? dialog.item.allowed_kinds : [...KNOWN_KINDS];
      const chosen = evidenceKind === '' || !allowed.includes(evidenceKind) ? (allowed[0] ?? 'ATTESTATION') : evidenceKind;
      const milestones = (detail.workflow?.links.milestones ?? []).filter((one) => one.actual_at !== null && (dialog.item.milestone_kind === null || one.kind === dialog.item.milestone_kind));
      const isDocument = chosen === 'DOCUMENT' || chosen === 'DECISION_DOCUMENT';
      const isMilestone = chosen === 'MILESTONE';
      const isReceipt = chosen === 'EXTERNAL_RECEIPT';
      return (
        <Guard sending={sending} open title={t('prc1.dialog.complete.title')} context={[...context, { label: t('prc1.dialog.item.label'), value: dialog.item.name }]} confirmLabel={t('prc1.dialog.complete.confirm')} cancelLabel={t('prc1.dialog.cancel.action')} pending={complete.isPending} error={refusal()} onCancel={close}
          onConfirm={() => {
            const evidence = reference.trim() === '' && note.trim() === '' ? [] : [{ kind: chosen, ...(isDocument ? { document_id: reference.trim() } : {}), ...(isMilestone ? { milestone_id: reference.trim() } : {}), ...(isReceipt ? { external_ref: reference.trim() } : {}), ...(note.trim() === '' ? {} : { note: note.trim() }) }];
            complete.mutate({ itemId: dialog.item.id, evidence }, { onSuccess: () => finish(), onError: fail });
          }}>
          {dialog.item.evidence_required && <p className="sub">{t('prc1.dialog.evidence.required')}</p>}
          <div className="field">
            <label htmlFor="prc1-evidence-kind">{t('prc1.dialog.evidenceKind.label')}</label>
            <select id="prc1-evidence-kind" value={chosen} onChange={(event) => { setEvidenceKind(event.target.value); setReference(''); }}>
              {allowed.map((one) => (
                <option key={one} value={one}>
                  {evidenceKindLabel(t, one)}
                </option>
              ))}
            </select>
          </div>
          {isMilestone ? (
            <div className="field">
              <label htmlFor="prc1-evidence-ref">{t('prc1.dialog.milestone.label')}</label>
              <select id="prc1-evidence-ref" value={reference} onChange={(event) => setReference(event.target.value)}>
                <option value="">{t('prc1.dialog.owner.choose')}</option>
                {milestones.map((one) => (
                  <option key={one.id} value={one.id}>
                    {milestoneLabel(t, one.kind)}
                  </option>
                ))}
              </select>
            </div>
          ) : chosen !== 'ATTESTATION' ? (
            <div className="field">
              <label htmlFor="prc1-evidence-ref">{isDocument ? t('prc1.dialog.document.label') : t('prc1.dialog.receipt.label')}</label>
              <input id="prc1-evidence-ref" type="text" value={reference} onChange={(event) => setReference(event.target.value)} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="prc1-evidence-note">{chosen === 'ATTESTATION' ? t('prc1.dialog.attestation.label') : t('prc1.dialog.note.label')}</label>
            <textarea id="prc1-evidence-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          {extra}
        </Guard>
      );
    }
  }
}
