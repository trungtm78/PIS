import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { wireControl } from '../../field-wiring';
import { Field } from '../components';
import { useContractorOptions } from '../proposal/hooks';
import type { TrackedPackage } from '../procurement/model';
import { useReceivePetition, useResolvePetition } from './hooks';
import { formProblemMessage, kindLabel, outcomeLabel, problemMessage } from './labels';
import { EMPTY_RESOLVE, OUTCOMES, PETITION_KINDS, describeProblem, emptyReceive, receiveBody, resolveBody, validateReceive, validateResolve, vietnamToday } from './model';
import type { PetitionLine, ReceiveForm, ResolveForm } from './model';
import '../bid.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

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

/** The frame both commands are asked in: a title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.petitions.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {hasError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(error))}
              </p>
            ) : null}
            {children}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('bid.petitions.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('bid.petitions.dialog.pending') : submitLabel}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

/**
 * The petition of a contractor about a package: its kind (the process, or the result), the contractor, the day it arrived and the paper that lodges it. The last day to answer is not
 * asked for: the server counts it from the rule data in force on the day the petition arrived, and the screen shows it once the petition is logged.
 */
export function ReceiveDialog({ pack, onClose }: { pack: TrackedPackage; onClose(): void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const contractors = useContractorOptions(true);
  const receive = useReceivePetition();
  const [form, setForm] = useState<ReceiveForm>(emptyReceive(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateReceive(form, today);
  const shown = (field: keyof ReceiveForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (receive.isPending || Object.keys(problems).length > 0) return;
    receive.mutate(receiveBody(pack.id, form), { onSuccess: onClose });
  };
  return (
    <Frame title={t('bid.petitions.receive.title', { code: pack.code })} error={receive.error} hasError={receive.isError} pending={receive.isPending} submitLabel={t('bid.petitions.receive.submit')} onSubmit={send} onClose={onClose}>
      <Field id="petition-kind" label={t('bid.petitions.field.kind')} error={shown('petitionKind')}>
        {wireControl(
          <select id="petition-kind" value={form.petitionKind} onChange={(event) => setForm({ ...form, petitionKind: PETITION_KINDS.find((kind) => kind === event.target.value) ?? '' })}>
            <option value="">{t('bid.petitions.field.kind.choose')}</option>
            {PETITION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(t, kind)}
              </option>
            ))}
          </select>,
          'petition-kind',
          { hint: false, error: shown('petitionKind') !== undefined },
        )}
      </Field>
      <Field id="petition-contractor" label={t('bid.petitions.field.contractor')} error={shown('contractorId')}>
        {wireControl(
          <select id="petition-contractor" value={form.contractorId} onChange={(event) => setForm({ ...form, contractorId: event.target.value })}>
            <option value="">{t('bid.petitions.field.contractor.choose')}</option>
            {(contractors.data ?? []).map((contractor) => (
              <option key={contractor.id} value={contractor.id}>
                {contractor.legalName}
              </option>
            ))}
          </select>,
          'petition-contractor',
          { hint: false, error: shown('contractorId') !== undefined },
        )}
      </Field>
      <Field id="petition-received" label={t('bid.petitions.field.received')} error={shown('receivedOn')} hint={t('bid.petitions.field.received.hint')}>
        {wireControl(<input id="petition-received" type="date" max={today} value={form.receivedOn} onChange={(event) => setForm({ ...form, receivedOn: event.target.value })} />, 'petition-received', {
          hint: false,
          error: shown('receivedOn') !== undefined,
        })}
      </Field>
      <Field id="petition-document" label={t('bid.petitions.field.document')} error={shown('documentId')} hint={t('bid.petitions.field.document.hint')}>
        {wireControl(<input id="petition-document" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />, 'petition-document', {
          hint: false,
          error: shown('documentId') !== undefined,
        })}
      </Field>
    </Frame>
  );
}

/**
 * The answer to a petition: the reply of the procuring entity, or the letter that passes it on to the level above, each a document. Whoever has a conflict of interest with the
 * contractor or the package is not offered this (the list says so); the server refuses them anyway.
 */
export function ResolveDialog({ line, onClose }: { line: PetitionLine; onClose(): void }) {
  const { t } = useTranslation();
  const resolve = useResolvePetition();
  const [form, setForm] = useState<ResolveForm>(EMPTY_RESOLVE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateResolve(form);
  const shown = (field: keyof ResolveForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (resolve.isPending || Object.keys(problems).length > 0) return;
    resolve.mutate({ id: line.id, version: line.version, body: resolveBody(form) }, { onSuccess: onClose });
  };
  // A petition that was passed on to the level above is answered by that level; it cannot be passed on again.
  const outcomes = line.status === 'ESCALATED' ? OUTCOMES.filter((outcome) => outcome === 'RESOLVED') : OUTCOMES;
  return (
    <Frame title={t('bid.petitions.resolve.title', { code: line.package.code })} error={resolve.error} hasError={resolve.isError} pending={resolve.isPending} submitLabel={t('bid.petitions.resolve.submit')} onSubmit={send} onClose={onClose}>
      <fieldset className="field" data-field="petition-outcome">
        <legend>{t('bid.petitions.field.outcome')}</legend>
        {outcomes.map((outcome) => (
          <label key={outcome} className="radio">
            <input type="radio" name="petition-outcome" value={outcome} data-outcome={outcome} checked={form.outcome === outcome} onChange={() => setForm({ ...form, outcome })} /> {outcomeLabel(t, outcome)}
          </label>
        ))}
        {shown('outcome') === undefined ? null : (
          <small role="alert" className="field-error">
            {shown('outcome')}
          </small>
        )}
      </fieldset>
      <Field id="petition-reply" label={t('bid.petitions.field.reply')} error={shown('documentId')} hint={t('bid.petitions.field.reply.hint')}>
        {wireControl(<input id="petition-reply" autoComplete="off" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />, 'petition-reply', {
          hint: false,
          error: shown('documentId') !== undefined,
        })}
      </Field>
    </Frame>
  );
}
