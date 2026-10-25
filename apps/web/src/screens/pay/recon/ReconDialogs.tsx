import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import type { PaymentRequest } from '../payment/model';
import { useAssign, useMatch, useResolve } from './hooks';
import { problemMessage, refusalMessage, resolutionLabel } from './labels';
import {
  EMPTY_ASSIGN,
  EMPTY_MATCH,
  EMPTY_RESOLVE,
  assignBody,
  candidatesFor,
  describeProblem,
  differenceText,
  itemLink,
  matchBody,
  resolveBody,
  sameAmount,
  validateAssign,
  validateMatch,
  validateResolve,
  vndText,
} from './model';
import type { AssignForm, MatchForm, MemberOption, ReconItem, Refusal, ResolveForm, Resolution, Settlement, Transaction } from './model';

/** The words of the frame the commands are asked in. */
function useFrameWords() {
  const { t } = useTranslation();
  return { close: t('pay.recon.dialog.close'), cancel: t('pay.recon.dialog.cancel'), pending: t('pay.recon.dialog.pending') };
}

export interface MatchDialogProps {
  transaction: Transaction;
  requests: readonly PaymentRequest[];
  onDone(settlement: Settlement | undefined): void;
  onClose(): void;
}

/**
 * Matching a Treasury transaction to a payment request (PAY 3.3 step 4): the request is picked from those that are with the Treasury, in the project of the transaction, each shown with its net so
 * the person sees at once whether the amounts agree. When they do not, the server refuses the match and opens a difference with an owner and a due day; the dialog then shows the two figures and
 * the difference, and leads to the item (PAY-06). It never offers to choose the larger figure.
 */
export function MatchDialog({ transaction, requests, onDone, onClose }: MatchDialogProps) {
  const { t, locale } = useTranslation();
  const words = useFrameWords();
  const match = useMatch();
  const [form, setForm] = useState<MatchForm>(EMPTY_MATCH);
  const [sent, setSent] = useState(false);
  const candidates = candidatesFor(requests, transaction);
  const problems = validateMatch(form);
  const money = (value: string): string => vndText(value, locale);
  const chosen = candidates.find((request) => request.id === form.requestId);
  const refusal: Refusal | undefined = match.isError ? describeProblem(match.error) : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (match.isPending || Object.keys(problems).length > 0) return;
    match.mutate({ transactionId: transaction.id, body: matchBody(form) }, { onSuccess: onDone });
  };
  return (
    <CommandFrame
      title={t('pay.recon.match.title', { voucher: transaction.documentNo ?? transaction.id })}
      refusal={refusal === undefined || refusal.problem === 'mismatch' ? undefined : refusalMessage(t, refusal)}
      pending={match.isPending}
      submitLabel={t('pay.recon.match.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p data-testid="match-amount">{t('pay.recon.match.intro', { amount: money(transaction.amountVnd) })}</p>
      {refusal?.problem === 'mismatch' ? (
        <div className="callout warning" role="alert" data-testid="mismatch">
          {refusal.mismatch === null ? (
            <p>{t('pay.recon.error.mismatch')}</p>
          ) : (
            <>
              <p>{t('pay.recon.match.mismatch', { internal: money(refusal.mismatch.internalVnd), confirmed: money(refusal.mismatch.confirmedVnd), difference: differenceText(refusal.mismatch.differenceVnd, locale) })}</p>
              <p>
                <Link to={itemLink(refusal.mismatch.itemId)} data-testid="mismatch-item">
                  {t('pay.recon.match.mismatch.open')}
                </Link>
              </p>
            </>
          )}
        </div>
      ) : null}
      <Field id="match-request" label={t('pay.recon.match.request.label')} error={sent && problems.requestId !== undefined ? problemMessage(t, problems.requestId) : undefined} hint={candidates.length === 0 ? t('pay.recon.match.request.empty') : undefined}>
        <select id="match-request" value={form.requestId} onChange={(event) => setForm({ ...form, requestId: event.target.value })}>
          <option value="">{t('pay.recon.match.request.choose')}</option>
          {candidates.map((request) => (
            <option key={request.id} value={request.id}>
              {t('pay.recon.match.request.option', { no: request.requestNo ?? request.id, net: money(request.netVnd) })}
            </option>
          ))}
        </select>
      </Field>
      {chosen === undefined ? null : (
        <p className="sub" data-testid="match-agree" data-agree={sameAmount(chosen.netVnd, transaction.amountVnd) ? 'yes' : 'no'}>
          {sameAmount(chosen.netVnd, transaction.amountVnd) ? t('pay.recon.match.agree') : t('pay.recon.match.differ')}
        </p>
      )}
      <Field id="match-note" label={t('pay.recon.match.note.label')} error={sent && problems.note !== undefined ? problemMessage(t, problems.note) : undefined}>
        <textarea id="match-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

export interface AssignDialogProps {
  item: ReconItem;
  people: readonly MemberOption[];
  /** The clock of the check that the day is to come; the dialog is told it so a test can turn it. */
  now(): Date;
  onDone(): void;
  onClose(): void;
}

/** Giving a difference to an owner with the day it is due: both are needed, the owner is an active member and the day is still to come. */
export function AssignDialog({ item, people, now, onDone, onClose }: AssignDialogProps) {
  const { t } = useTranslation();
  const words = useFrameWords();
  const assign = useAssign();
  const [form, setForm] = useState<AssignForm>({ ...EMPTY_ASSIGN, ownerId: item.ownerMembershipId });
  const [sent, setSent] = useState(false);
  const problems = validateAssign(form, now());
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
      title={t('pay.item.assign.title')}
      refusal={assign.isError ? refusalMessage(t, describeProblem(assign.error)) : undefined}
      pending={assign.isPending}
      submitLabel={t('pay.item.assign.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="assign-owner" label={t('pay.item.field.owner')} error={shown('ownerId')}>
        {people.length > 0 ? (
          <select id="assign-owner" value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })}>
            <option value="">{t('pay.item.assign.owner.choose')}</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        ) : (
          <input id="assign-owner" autoComplete="off" value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })} />
        )}
      </Field>
      <Field id="assign-due" label={t('pay.item.field.due')} error={shown('dueAt')} hint={t('pay.item.field.due.hint')}>
        <input id="assign-due" type="datetime-local" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} />
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
 * Explaining, resolving or writing off a difference: the words of the person are always needed; a write-off also needs the document that approves it, and the server refuses the owner of the
 * difference as the one who signs. The two figures are never edited: the dialog says so.
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
      title={t('pay.item.resolve.title', { action: resolutionLabel(t, resolution) })}
      refusal={resolve.isError ? refusalMessage(t, describeProblem(resolve.error)) : undefined}
      pending={resolve.isPending}
      submitLabel={resolutionLabel(t, resolution)}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p>{resolution === 'WRITTEN_OFF' ? t('pay.item.resolve.writeOff.intro') : t('pay.item.resolve.intro')}</p>
      <Field id="resolve-note" label={t('pay.item.field.note')} error={shown('note')} hint={t('pay.item.field.note.hint')}>
        <textarea id="resolve-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
      {resolution === 'WRITTEN_OFF' ? (
        <Field id="resolve-approval" label={t('pay.item.field.approval')} error={shown('approvalDocumentVersionId')} hint={t('pay.item.field.approval.hint')}>
          <input id="resolve-approval" autoComplete="off" value={form.approvalDocumentVersionId} onChange={(event) => setForm({ ...form, approvalDocumentVersionId: event.target.value })} />
        </Field>
      ) : null}
    </CommandFrame>
  );
}
