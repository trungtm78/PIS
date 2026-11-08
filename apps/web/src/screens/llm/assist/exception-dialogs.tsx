import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { Field, describedBy } from './assist-components';
import { useAttestProvider, useDecideException, useReload, useRequestException, useRevokeException } from './assist-hooks';
import { approvalProblemText, classificationText, errorText, fieldProblemText } from './assist-labels';
import { CLASSIFICATIONS, MAX_EXCEPTION_DAYS, MIN_EXCEPTION_REASON, MIN_NOTE, approvalProblem, attestBody, emptyAttest, emptyRequest, exceptionDecisionBody, isExternal, isVersionConflict, requestBody, revokeReasonOk, shortId, validateAttest, validateRequest } from './assist-model';
import type { AttestErrors, AttestForm, Classification, ExceptionRow, FieldProblem, ProviderRow, RequestErrors, RequestForm } from './assist-model';

export interface DialogProps {
  onClose: () => void;
  onDone: (receipt: string) => void;
}

/** What every dialog of a command does with the answer: sends once, says the refusal inside the dialog, and offers the reading again when the record moved under the person. */
function useCommandDialog() {
  const { t } = useTranslation();
  const reload = useReload();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const sending = useRef(false);
  return {
    error: message ?? (failure === undefined ? undefined : errorText(t, failure)),
    conflict: isVersionConflict(failure),
    reload,
    setMessage,
    run: (start: (callbacks: { onSuccess: () => void; onError: (error: unknown) => void }) => void, success: () => void): void => {
      if (sending.current) return;
      sending.current = true;
      setFailure(undefined);
      setMessage(undefined);
      start({
        onSuccess: () => {
          sending.current = false;
          success();
        },
        onError: (error) => {
          sending.current = false;
          setFailure(error);
        },
      });
    },
  };
}

function ReloadButton({ dialog, onClose }: { dialog: ReturnType<typeof useCommandDialog>; onClose: () => void }) {
  const { t } = useTranslation();
  if (!dialog.conflict) return null;
  return (
    <button
      type="button"
      className="ui-button ui-button--outline ui-button--small"
      data-testid="reload-after-conflict"
      onClick={() => {
        dialog.reload();
        onClose();
      }}
    >
      {t('llm.exceptions.dialog.reload')}
    </button>
  );
}

const problemText = (t: ReturnType<typeof useTranslation>['t'], problem: FieldProblem | undefined): string | undefined => (problem === undefined ? undefined : fieldProblemText(t, problem));

// ---- the attestation of a provider --------------------------------------------------------------------------------------------------------------------------------

export function AttestDialog({ provider, onClose, onDone }: DialogProps & { provider: ProviderRow }) {
  const { t } = useTranslation();
  const attest = useAttestProvider();
  const dialog = useCommandDialog();
  const [form, setForm] = useState<AttestForm>(() => ({ ...emptyAttest(), country: provider.country ?? '', detail: provider.locationDetail ?? '', noTraining: provider.noTrainingAttested ?? false, reference: provider.attestationRef ?? '' }));
  const [errors, setErrors] = useState<AttestErrors>({});
  const set = (change: Partial<AttestForm>): void => {
    setForm((previous) => ({ ...previous, ...change }));
    setErrors({});
  };
  const confirm = (): void => {
    const found = validateAttest(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    dialog.run(
      (callbacks) => attest.mutate({ providerId: provider.id, version: provider.version, body: attestBody(form) }, callbacks),
      () => {
        onClose();
        onDone(t('llm.exceptions.attest.done', { code: provider.code }));
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={t('llm.exceptions.attest.title', { code: provider.code })}
      context={[
        { label: t('llm.exceptions.column.provider'), value: provider.name },
        { label: t('llm.exceptions.column.route'), value: provider.code },
      ]}
      confirmLabel={t('llm.exceptions.attest.confirm')}
      cancelLabel={t('llm.exceptions.dialog.cancel')}
      pending={attest.isPending}
      {...(dialog.error === undefined ? {} : { error: dialog.error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="assist-dialog-body" data-testid="attest-form">
        <Field id="attest-country" label={t('llm.exceptions.attest.country')} hint={t('llm.exceptions.attest.countryHint')} error={problemText(t, errors.country)}>
          <input id="attest-country" value={form.country} maxLength={2} autoComplete="off" aria-invalid={errors.country !== undefined} aria-describedby={describedBy('attest-country', true, errors.country !== undefined)} onChange={(event) => set({ country: event.target.value.toUpperCase() })} />
        </Field>
        <Field id="attest-detail" label={t('llm.exceptions.attest.detail')} error={problemText(t, errors.detail)}>
          <input id="attest-detail" value={form.detail} maxLength={300} aria-invalid={errors.detail !== undefined} aria-describedby={describedBy('attest-detail', false, errors.detail !== undefined)} onChange={(event) => set({ detail: event.target.value })} />
        </Field>
        <label className="assist-check">
          <input type="checkbox" checked={form.noTraining} onChange={(event) => set({ noTraining: event.target.checked })} />
          <span>{t('llm.exceptions.attest.noTraining')}</span>
        </label>
        <Field id="attest-reference" label={t('llm.exceptions.attest.reference')} error={problemText(t, errors.reference)}>
          <input id="attest-reference" value={form.reference} maxLength={300} aria-invalid={errors.reference !== undefined} aria-describedby={describedBy('attest-reference', false, errors.reference !== undefined)} onChange={(event) => set({ reference: event.target.value })} />
        </Field>
        <Field id="attest-document" label={t('llm.exceptions.attest.document')} error={problemText(t, errors.documentId)}>
          <input id="attest-document" value={form.documentId} autoComplete="off" spellCheck={false} aria-invalid={errors.documentId !== undefined} aria-describedby={describedBy('attest-document', false, errors.documentId !== undefined)} onChange={(event) => set({ documentId: event.target.value })} />
        </Field>
        <ReloadButton dialog={dialog} onClose={onClose} />
      </div>
    </ConfirmDialog>
  );
}

// ---- a request for an exception --------------------------------------------------------------------------------------------------------------------------------------

export function RequestDialog({ providers, onClose, onDone }: DialogProps & { providers: readonly ProviderRow[] }) {
  const { t } = useTranslation();
  const request = useRequestException();
  const dialog = useCommandDialog();
  const [form, setForm] = useState<RequestForm>(() => emptyRequest());
  const [errors, setErrors] = useState<RequestErrors>({});
  const external = providers.filter(isExternal);
  const set = (change: Partial<RequestForm>): void => {
    setForm((previous) => ({ ...previous, ...change }));
    setErrors({});
  };
  const confirm = (): void => {
    const found = validateRequest(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    dialog.run(
      (callbacks) => request.mutate(requestBody(form), callbacks),
      () => {
        onClose();
        onDone(t('llm.exceptions.request.done', { code: external.find((provider) => provider.id === form.providerId)?.code ?? shortId(form.providerId) }));
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={t('llm.exceptions.request.title')}
      context={[]}
      confirmLabel={t('llm.exceptions.request.confirm')}
      cancelLabel={t('llm.exceptions.dialog.cancel')}
      pending={request.isPending}
      {...(dialog.error === undefined ? {} : { error: dialog.error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="assist-dialog-body" data-testid="request-form">
        <Field id="request-provider" label={t('llm.exceptions.request.provider')} error={problemText(t, errors.providerId)}>
          <select id="request-provider" value={form.providerId} aria-invalid={errors.providerId !== undefined} aria-describedby={describedBy('request-provider', false, errors.providerId !== undefined)} onChange={(event) => set({ providerId: event.target.value })}>
            <option value="">{t('llm.exceptions.request.chooseProvider')}</option>
            {external.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.code})
              </option>
            ))}
          </select>
        </Field>
        <Field id="request-task" label={t('llm.exceptions.request.task')} hint={t('llm.exceptions.request.taskHint')} error={problemText(t, errors.taskType)}>
          <input id="request-task" value={form.taskType} maxLength={60} autoComplete="off" aria-invalid={errors.taskType !== undefined} aria-describedby={describedBy('request-task', true, errors.taskType !== undefined)} onChange={(event) => set({ taskType: event.target.value.toUpperCase() })} />
        </Field>
        <Field id="request-class" label={t('llm.exceptions.request.class')}>
          <select id="request-class" value={form.maxClassification} onChange={(event) => set({ maxClassification: event.target.value as Classification })}>
            {CLASSIFICATIONS.map((level) => (
              <option key={level} value={level}>
                {classificationLabel(t, level)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="request-reason" label={t('llm.exceptions.request.reason')} hint={t('llm.exceptions.request.reasonHint', { count: MIN_EXCEPTION_REASON })} error={problemText(t, errors.reason)}>
          <textarea id="request-reason" rows={3} value={form.reason} aria-invalid={errors.reason !== undefined} aria-describedby={describedBy('request-reason', true, errors.reason !== undefined)} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        <Field id="request-days" label={t('llm.exceptions.request.days')} hint={t('llm.exceptions.request.daysHint', { max: MAX_EXCEPTION_DAYS })} error={problemText(t, errors.days)}>
          <input id="request-days" inputMode="numeric" value={form.days} aria-invalid={errors.days !== undefined} aria-describedby={describedBy('request-days', true, errors.days !== undefined)} onChange={(event) => set({ days: event.target.value })} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

// ---- the decision on a request --------------------------------------------------------------------------------------------------------------------------------------------

export type DecisionKind = 'APPROVE' | 'REJECT';

/** Approving needs the reference of the approval on file; rejecting needs a note. A request is decided by another person than the one who asked (the server refuses the same person). */
export function DecideDialog({ row, decision, onClose, onDone }: DialogProps & { row: ExceptionRow; decision: DecisionKind }) {
  const { t } = useTranslation();
  const decide = useDecideException();
  const dialog = useCommandDialog();
  const [reference, setReference] = useState('');
  const approve = decision === 'APPROVE';
  const confirm = (note: string | undefined): void => {
    const problem = approvalProblem(decision, reference, note ?? '');
    if (problem !== undefined) {
      dialog.setMessage(approvalProblemText(t, problem));
      return;
    }
    dialog.run(
      (callbacks) => decide.mutate({ id: row.id, version: row.version, body: exceptionDecisionBody(decision, reference, note ?? '') }, callbacks),
      () => {
        onClose();
        onDone(approve ? t('llm.exceptions.decide.approved', { code: row.providerCode }) : t('llm.exceptions.decide.rejected', { code: row.providerCode }));
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={approve ? t('llm.exceptions.decide.approveTitle', { code: row.providerCode }) : t('llm.exceptions.decide.rejectTitle', { code: row.providerCode })}
      context={[
        { label: t('llm.exceptions.column.provider'), value: row.providerCode },
        { label: t('llm.exceptions.column.task'), value: row.taskType ?? t('llm.exceptions.allTasks') },
        { label: t('llm.exceptions.column.class'), value: row.maxClassification === null ? '–' : classificationLabel(t, row.maxClassification) },
        { label: t('llm.exceptions.decide.days'), value: String(row.requestedDays) },
        { label: t('llm.exceptions.decide.reason'), value: row.reason },
      ]}
      confirmLabel={approve ? t('llm.exceptions.decide.approveConfirm') : t('llm.exceptions.decide.rejectConfirm')}
      cancelLabel={t('llm.exceptions.dialog.cancel')}
      pending={decide.isPending}
      reason={approve ? { label: t('llm.exceptions.decide.noteOptional'), hint: t('llm.exceptions.decide.noteHint', { count: MIN_NOTE }) } : { label: t('llm.exceptions.decide.note'), required: true, minLength: MIN_NOTE, hint: t('llm.exceptions.decide.noteHint', { count: MIN_NOTE }) }}
      {...(dialog.error === undefined ? {} : { error: dialog.error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      {approve ? (
        <Field id="decide-reference" label={t('llm.exceptions.decide.reference')} hint={t('llm.exceptions.decide.referenceHint')}>
          <input id="decide-reference" value={reference} maxLength={300} autoComplete="off" aria-describedby={describedBy('decide-reference', true, false)} onChange={(event) => setReference(event.target.value)} />
        </Field>
      ) : null}
      <ReloadButton dialog={dialog} onClose={onClose} />
    </ConfirmDialog>
  );
}

// ---- the revocation of an exception --------------------------------------------------------------------------------------------------------------------------------

export function RevokeDialog({ row, onClose, onDone }: DialogProps & { row: ExceptionRow }) {
  const { t } = useTranslation();
  const revoke = useRevokeException();
  const dialog = useCommandDialog();
  const confirm = (reason: string | undefined): void => {
    if (!revokeReasonOk(reason ?? '')) {
      dialog.setMessage(fieldProblemText(t, 'short'));
      return;
    }
    dialog.run(
      (callbacks) => revoke.mutate({ id: row.id, version: row.version, body: { reason: (reason ?? '').trim() } }, callbacks),
      () => {
        onClose();
        onDone(t('llm.exceptions.revoke.done', { code: row.providerCode }));
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={t('llm.exceptions.revoke.title', { code: row.providerCode })}
      context={[
        { label: t('llm.exceptions.column.provider'), value: row.providerCode },
        { label: t('llm.exceptions.column.task'), value: row.taskType ?? t('llm.exceptions.allTasks') },
        { label: t('llm.exceptions.column.uses'), value: String(row.useCount) },
      ]}
      confirmLabel={t('llm.exceptions.revoke.confirm')}
      cancelLabel={t('llm.exceptions.dialog.cancel')}
      pending={revoke.isPending}
      reason={{ label: t('llm.exceptions.revoke.reason'), required: true, minLength: MIN_NOTE, hint: t('llm.exceptions.decide.noteHint', { count: MIN_NOTE }) }}
      {...(dialog.error === undefined ? {} : { error: dialog.error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <p className="assist-note">{t('llm.exceptions.revoke.note')}</p>
      <ReloadButton dialog={dialog} onClose={onClose} />
    </ConfirmDialog>
  );
}
