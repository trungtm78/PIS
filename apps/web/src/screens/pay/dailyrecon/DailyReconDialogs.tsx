import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { refusalMessage, resolutionLabel } from '../recon/labels';
import { useAssign, useResolve } from './hooks';
import { problemMessage } from './labels';
import { EMPTY_ASSIGN, EMPTY_RESOLVE, assignBody, describeProblem, resolveBody, validateAssign, validateResolve } from './model';
import type { AssignForm, MemberOption, ReconItem, ResolveForm, Resolution } from './model';

/** The words of the frame the commands are asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('govd.recon.dialog.close'), cancel: t('govd.recon.dialog.cancel'), pending: t('govd.recon.dialog.pending') };
}

export interface AssignDialogProps {
  item: ReconItem;
  people: readonly MemberOption[];
  /** The day in Vietnam today: the day it is due cannot be before it. */
  today: string;
  onDone(): void;
  onClose(): void;
}

/** Giving an item to an owner with the day it is due: both are needed, the owner is an active member and the day is not before today. */
export function AssignDialog({ item, people, today, onDone, onClose }: AssignDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const assign = useAssign();
  const [form, setForm] = useState<AssignForm>({ ...EMPTY_ASSIGN, ownerId: item.ownerMembershipId, dueOn: item.dueOn >= today ? item.dueOn : today });
  const [sent, setSent] = useState(false);
  const problems = validateAssign(form, today);
  const shown = (field: keyof AssignForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate({ id: item.id, version: item.version, body: assignBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('govd.recon.assign.title', { project: item.projectCode, fund: item.fundKey })}
      refusal={assign.isError ? refusalMessage(t, describeProblem(assign.error)) : undefined}
      pending={assign.isPending}
      submitLabel={t('govd.recon.assign.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="daily-assign-owner" label={t('govd.recon.assign.owner')} error={shown('ownerId')}>
        {people.length > 0 ? (
          <select id="daily-assign-owner" value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })}>
            <option value="">{t('govd.recon.assign.ownerChoose')}</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        ) : (
          <input id="daily-assign-owner" autoComplete="off" value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })} />
        )}
      </Field>
      <Field id="daily-assign-due" label={t('govd.recon.assign.due')} error={shown('dueOn')} hint={t('govd.recon.assign.dueHint')}>
        <input id="daily-assign-due" type="date" min={today} value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

export interface ResolveDialogProps {
  item: ReconItem;
  resolution: Resolution;
  onDone(): void;
  onClose(): void;
}

/**
 * Explaining, resolving or writing off an item: the words of the person are always needed; a write-off also needs the document that approves it and someone who is not the owner, the person who explained it or the person who opened
 * it (the server refuses them). The two figures an item was opened with are never edited: the dialog says so.
 */
export function ResolveDialog({ item, resolution, onDone, onClose }: ResolveDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const resolve = useResolve();
  const [form, setForm] = useState<ResolveForm>(EMPTY_RESOLVE);
  const [sent, setSent] = useState(false);
  const problems = validateResolve(form, resolution);
  const shown = (field: keyof ResolveForm): string | undefined => {
    const problem = problems[field];
    return sent && problem !== undefined ? problemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (resolve.isPending || Object.keys(problems).length > 0) return;
    resolve.mutate({ id: item.id, version: item.version, body: resolveBody(form, resolution) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('govd.recon.resolve.title', { action: resolutionLabel(t, resolution), project: item.projectCode, fund: item.fundKey })}
      refusal={resolve.isError ? refusalMessage(t, describeProblem(resolve.error)) : undefined}
      pending={resolve.isPending}
      submitLabel={resolutionLabel(t, resolution)}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{resolution === 'WRITTEN_OFF' ? t('govd.recon.resolve.writeOffIntro') : t('govd.recon.resolve.intro')}</p>
      <Field id="daily-resolve-note" label={t('govd.recon.resolve.note')} error={shown('note')} hint={t('govd.recon.resolve.noteHint')}>
        <textarea id="daily-resolve-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
      {resolution === 'WRITTEN_OFF' ? (
        <Field id="daily-resolve-approval" label={t('govd.recon.resolve.approval')} error={shown('approvalDocumentVersionId')} hint={t('govd.recon.resolve.approvalHint')}>
          <input id="daily-resolve-approval" autoComplete="off" value={form.approvalDocumentVersionId} onChange={(event) => setForm({ ...form, approvalDocumentVersionId: event.target.value })} />
        </Field>
      ) : null}
    </CommandFrame>
  );
}
