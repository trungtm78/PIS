import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { ContractLine } from '../../ctr/model';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../CommandFrame';
import { useContractorSign, useCorrectDiary, useLockDiary, useOwnerConfirm, useSaveDiary, useSupervise } from './hooks';
import { OtherContent } from './DiaryParts';
import { formProblemMessage, methodLabel, problemMessage, weatherLabel, weatherOptions } from './labels';
import { SIGNATURE_METHODS, contentOf, describeProblem, emptyDiary, emptySign, formOf, saveBody, signBody, validateDiary, validateReason, validateSign } from './model';
import type { DiaryForm, DiaryLine, SignForm } from './model';
import '../qms.css';

interface FrameProps {
  title: string;
  error: unknown;
  hasError: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit(event: FormEvent): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame the commands are asked in: the title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const words = { close: t('qms.diary.dialog.close'), cancel: t('qms.diary.dialog.cancel'), pending: t('qms.diary.dialog.pending') };
  return (
    <CommandFrame title={title} refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined} pending={pending} submitLabel={submitLabel} words={words} onSubmit={onSubmit} onClose={onClose}>
      {/* While the command is on its way the fields wait: what is typed after the send is not in it, and the dialog closes on success. */}
      <fieldset className="qms-plain" disabled={pending}>
        {children}
      </fieldset>
    </CommandFrame>
  );
}

/** The fields of what the diary says; `base` holds what another client wrote and the form does not show. */
export function ContentFields({ form, set, shown, prefix }: { form: DiaryForm; set: (change: Partial<DiaryForm>) => void; shown: (field: keyof DiaryForm) => string | undefined; prefix: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Field id={`${prefix}-summary`} label={t('qms.diary.field.summary')} error={shown('summary')}>
        <textarea id={`${prefix}-summary`} rows={5} value={form.summary} onChange={(event) => set({ summary: event.target.value })} />
      </Field>
      <Field id={`${prefix}-weather`} label={t('qms.diary.field.weather')} error={shown('weatherCode')}>
        <select id={`${prefix}-weather`} value={form.weatherCode} onChange={(event) => set({ weatherCode: event.target.value })}>
          <option value="">{t('qms.diary.field.weather.none')}</option>
          {((weatherOptions as readonly string[]).includes(form.weatherCode) || form.weatherCode === '' ? [...weatherOptions] : [...weatherOptions, form.weatherCode]).map((code) => (
            <option key={code} value={code}>
              {weatherLabel(t, code)}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${prefix}-workforce`} label={t('qms.diary.field.workforce')} error={shown('workforceCount')}>
        <input id={`${prefix}-workforce`} inputMode="numeric" autoComplete="off" value={form.workforceCount} onChange={(event) => set({ workforceCount: event.target.value })} />
      </Field>
      <Field id={`${prefix}-notes`} label={t('qms.diary.field.notes')} error={shown('notes')}>
        <textarea id={`${prefix}-notes`} rows={3} value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
      </Field>
    </>
  );
}

/** Drafting the diary of a day: the contract, the day and what the day was. Another diary of that day is refused by the server, and what the server refuses is said in words. */
export function NewDiaryDialog({ contracts, today, initialContract, onClose, onSaved }: { contracts: readonly ContractLine[]; today: string; initialContract: string; onClose(): void; onSaved(id: string): void }) {
  const { t } = useTranslation();
  const save = useSaveDiary();
  const [form, setDraft] = useState<DiaryForm>({ ...emptyDiary(today), contractId: initialContract });
  // One diary, one identifier: a retry of this diary is this diary (the identifier is made when the dialog opens).
  const [operation, setOperation] = useState(() => crypto.randomUUID());
  // The identifier belongs to the payload: a retry of the same diary keeps it, and a diary that was changed after a send whose answer was lost is another operation (the server answers that the day has a diary, instead of taking the first for this).
  const setForm = (next: DiaryForm): void => {
    setDraft(next);
    setOperation(crypto.randomUUID());
  };
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDiary(form, today, true);
  const shown = (field: keyof DiaryForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (save.isPending || Object.keys(problems).length > 0) return;
    save.mutate(saveBody(form, operation), { onSuccess: (answer) => onSaved(String((answer as { resource_id?: string } | undefined)?.resource_id ?? '')) });
  };
  return (
    <Frame title={t('qms.diary.new.title')} error={save.error} hasError={save.isError} pending={save.isPending} submitLabel={t('qms.diary.new.submit')} onSubmit={send} onClose={onClose}>
      <Field id="diary-contract" label={t('qms.diary.field.contract')} error={shown('contractId')}>
        <select id="diary-contract" value={form.contractId} onChange={(event) => setForm({ ...form, contractId: event.target.value })}>
          <option value="">{t('qms.diary.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="diary-date" label={t('qms.diary.field.date')} error={shown('recordDate')}>
        <input id="diary-date" type="date" max={today} value={form.recordDate} onChange={(event) => setForm({ ...form, recordDate: event.target.value })} />
      </Field>
      <ContentFields form={form} set={(change) => setForm({ ...form, ...change })} shown={shown} prefix="new" />
    </Frame>
  );
}

type SignKind = 'contractor' | 'supervisor' | 'owner';

/**
 * Signing a diary as the role whose turn it is. The supervisor says what they remark and the owner may add a note; a certificate is a legal electronic signature and carries its serial, an in-app confirmation is an
 * internal record and carries none.
 */
export function SignDialog({ line, kind, onClose }: { line: DiaryLine; kind: SignKind; onClose(): void }) {
  const { t } = useTranslation();
  const contractor = useContractorSign();
  const supervisor = useSupervise();
  const owner = useOwnerConfirm();
  const mutation = kind === 'contractor' ? contractor : kind === 'supervisor' ? supervisor : owner;
  // The diary as it was when the dialog opened: a refresh behind the dialog does not change what is signed (the server refuses a version that moved).
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  // One signature, one identifier: a retry of this signature is this signature (the identifier is made when the dialog opens).
  const [form, setSigned] = useState<SignForm>(() => emptySign(crypto.randomUUID()));
  // The identifier belongs to what is signed with: a change of the words, the way or the serial is another operation.
  const setForm = (next: SignForm): void => setSigned({ ...next, clientOperationId: crypto.randomUUID() });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSign(form, kind === 'supervisor');
  const shown = (field: keyof SignForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (mutation.isPending || Object.keys(problems).length > 0) return;
    const body = signBody(form);
    const words = form.words.trim();
    const done = { onSuccess: onClose };
    if (kind === 'contractor') contractor.mutate({ id: opened.id, version: opened.version, body }, done);
    else if (kind === 'supervisor') supervisor.mutate({ id: opened.id, version: opened.version, body: { ...body, remark: words } }, done);
    else owner.mutate({ id: opened.id, version: opened.version, body: { ...body, ...(words === '' ? {} : { note: words }) } }, done);
  };
  const title = kind === 'contractor' ? t('qms.diary.sign.contractor.title', { no: line.diaryNo }) : kind === 'supervisor' ? t('qms.diary.sign.supervisor.title', { no: line.diaryNo }) : t('qms.diary.sign.owner.title', { no: line.diaryNo });
  return (
    <Frame title={title} error={mutation.error} hasError={mutation.isError} pending={mutation.isPending} submitLabel={t('qms.diary.sign.submit')} onSubmit={send} onClose={onClose}>
      {kind === 'contractor' ? null : (
        <Field id="sign-words" label={kind === 'supervisor' ? t('qms.diary.field.remark') : t('qms.diary.field.ownerNote')} error={shown('words')}>
          <textarea id="sign-words" rows={3} value={form.words} onChange={(event) => setForm({ ...form, words: event.target.value })} />
        </Field>
      )}
      <Field id="sign-method" label={t('qms.diary.field.method')} error={shown('method')}>
        <select id="sign-method" value={form.method} onChange={(event) => setForm({ ...form, method: SIGNATURE_METHODS.find((method) => method === event.target.value) ?? '' })}>
          <option value="">{t('qms.diary.field.method.choose')}</option>
          {SIGNATURE_METHODS.map((method) => (
            <option key={method} value={method}>
              {methodLabel(t, method)}
            </option>
          ))}
        </select>
      </Field>
      {form.method === '' ? null : (
        <p className="sub" data-testid="sign-effect">
          {form.method === 'DIGITAL_CERT' ? t('qms.diary.effect.legal') : t('qms.diary.effect.internal')}
        </p>
      )}
      {form.method === 'DIGITAL_CERT' || form.certSerial !== '' ? (
        <Field id="sign-serial" label={t('qms.diary.field.certSerial')} error={shown('certSerial')}>
          <input id="sign-serial" autoComplete="off" value={form.certSerial} onChange={(event) => setForm({ ...form, certSerial: event.target.value })} />
        </Field>
      ) : null}
      {line.signatureValue.awaitingConfirmation ? <p className="qms-badge warning">{t('qms.diary.legal.unconfirmed', { cxn: line.signatureValue.cxn })}</p> : null}
    </Frame>
  );
}

/** Locking a diary that was remarked on: from then on only a correction replaces it. The reason is optional. */
export function LockDialog({ line, onClose }: { line: DiaryLine; onClose(): void }) {
  const { t } = useTranslation();
  const lock = useLockDiary();
  const [opened] = useState(() => ({ id: line.id, version: line.version }));
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateReason(reason, false);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (lock.isPending || problem !== undefined) return;
    lock.mutate({ id: opened.id, version: opened.version, body: reason.trim() === '' ? {} : { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame title={t('qms.diary.lock.title', { no: line.diaryNo })} error={lock.error} hasError={lock.isError} pending={lock.isPending} submitLabel={t('qms.diary.lock.submit')} onSubmit={send} onClose={onClose}>
      <p className="sub">{t('qms.diary.lock.hint')}</p>
      <Field id="lock-reason" label={t('qms.diary.field.lockReason')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}>
        <textarea id="lock-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  );
}

/** Correcting a locked diary: a new revision, with the reason, that is signed again; the diary that it corrects is kept as it is until the correction is locked. */
export function CorrectDialog({ line, onClose, onSaved }: { line: DiaryLine; onClose(): void; onSaved(id: string): void }) {
  const { t } = useTranslation();
  const correct = useCorrectDiary();
  // What the correction is made over: the diary as it was when the dialog opened.
  const [opened] = useState(() => ({ id: line.id, content: line.content }));
  const [form, setDraft] = useState<DiaryForm>(() => formOf(line));
  const [reason, setWhy] = useState('');
  const [operation, setOperation] = useState(() => crypto.randomUUID());
  // The identifier belongs to the payload: a correction that was changed after a send whose answer was lost is another operation.
  const setForm = (next: DiaryForm): void => {
    setDraft(next);
    setOperation(crypto.randomUUID());
  };
  const setReason = (next: string): void => {
    setWhy(next);
    setOperation(crypto.randomUUID());
  };
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDiary(form, '9999-12-31', false);
  const reasonProblem = validateReason(reason, true);
  const shown = (field: keyof DiaryForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (correct.isPending || Object.keys(problems).length > 0 || reasonProblem !== undefined) return;
    correct.mutate({ id: opened.id, body: { content: contentOf(form, opened.content), correction_reason: reason.trim(), client_operation_id: operation } }, { onSuccess: (answer) => onSaved(String((answer as { resource_id?: string } | undefined)?.resource_id ?? '')) });
  };
  return (
    <Frame title={t('qms.diary.correct.title', { no: line.diaryNo })} error={correct.error} hasError={correct.isError} pending={correct.isPending} submitLabel={t('qms.diary.correct.submit')} onSubmit={send} onClose={onClose}>
      <p className="sub">{t('qms.diary.correct.hint')}</p>
      <Field id="correct-reason" label={t('qms.diary.field.correctionReason')} error={submitted && reasonProblem !== undefined ? formProblemMessage(t, reasonProblem) : undefined}>
        <textarea id="correct-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <ContentFields form={form} set={(change) => setForm({ ...form, ...change })} shown={shown} prefix="correct" />
      <OtherContent content={opened.content} />
    </Frame>
  );
}
