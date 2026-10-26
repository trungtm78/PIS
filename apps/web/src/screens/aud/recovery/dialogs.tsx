import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field, errorOf } from '../components';
import { conclusionFormProblemMessage } from '../conclusion/labels';
import { formatVnd } from '../conclusion/model';
import { todayInVietnam } from '../model';
import { useLinkRecovery, useReverseRecovery } from './hooks';
import { recoveryProblemMessage, sourceKindLabel } from './labels';
import { EMPTY_LINK_FORM, EMPTY_REVERSE_FORM, MANUAL_SOURCES, describeRecovery, linkBody, recoverable, reverseBody, validateLink, validateReverse } from './model';
import type { LinkForm, RecoveryLine, ReverseForm, SummaryItem } from './model';

interface Mutation {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/** The refusal a dialog shows once its command was refused, in words; none before. */
function refusalOf(t: ReturnType<typeof useTranslation>['t'], mutation: Mutation): string | undefined {
  if (!mutation.isError) return undefined;
  const described = describeRecovery(mutation.error);
  return recoveryProblemMessage(t, described.problem, described.remainingVnd);
}

/**
 * A recovery that PAY does not report (a payment straight to the Treasury, a document), entered by an accountant with the document that proves it. The dialog says what is left to recover on
 * the recommendation chosen and refuses an amount above it before it is sent; the server checks the same again under a lock, so two accountants at once cannot both fit.
 */
export function LinkDialog({ recommendations, preselected, onClose }: { recommendations: readonly SummaryItem[]; preselected: string | undefined; onClose(): void }) {
  const { t } = useTranslation();
  const link = useLinkRecovery();
  const today = todayInVietnam();
  const options = recoverable(recommendations);
  const [form, setForm] = useState<LinkForm>({ ...EMPTY_LINK_FORM, recommendationId: preselected ?? '', recordedOn: today });
  const [submitted, setSubmitted] = useState(false);
  const chosen = options.find((item) => item.recommendationId === form.recommendationId);
  const problems = validateLink(form, chosen?.remainingVnd, today);
  const error = (field: keyof LinkForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (link.isPending || Object.keys(problems).length > 0 || chosen === undefined) return;
    link.mutate({ id: chosen.recommendationId, version: chosen.version, body: linkBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.recovery.link.title')} onClose={onClose} refusal={refusalOf(t, link)} pending={link.isPending} onSubmit={submit}>
      <Field id="link-recommendation" label={t('aud.recovery.link.recommendation.label')} error={error('recommendationId')}>
        <select id="link-recommendation" value={form.recommendationId} onChange={(event) => setForm({ ...form, recommendationId: event.target.value })}>
          <option value="">{t('aud.recovery.link.recommendation.choose')}</option>
          {options.map((item) => (
            <option key={item.recommendationId} value={item.recommendationId}>
              {item.code}
            </option>
          ))}
        </select>
      </Field>
      <Field id="link-source" label={t('aud.recovery.link.source.label')} error={error('sourceKind')} hint={t('aud.recovery.link.source.help')}>
        <select id="link-source" value={form.sourceKind} onChange={(event) => setForm({ ...form, sourceKind: event.target.value as LinkForm['sourceKind'] })}>
          <option value="">{t('aud.recovery.link.source.choose')}</option>
          {MANUAL_SOURCES.map((source) => (
            <option key={source} value={source}>
              {sourceKindLabel(t, source)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="link-amount"
        label={t('aud.recovery.link.amount.label')}
        error={error('amountVnd')}
        hint={chosen === undefined ? t('aud.recovery.link.amount.help') : t('aud.recovery.link.amount.remaining', { remaining: formatVnd(chosen.remainingVnd) })}
      >
        <input id="link-amount" inputMode="numeric" value={form.amountVnd} onChange={(event) => setForm({ ...form, amountVnd: event.target.value })} />
      </Field>
      <Field id="link-day" label={t('aud.recovery.link.day.label')} error={error('recordedOn')}>
        <input id="link-day" type="date" max={today} value={form.recordedOn} onChange={(event) => setForm({ ...form, recordedOn: event.target.value })} />
      </Field>
      <Field id="link-evidence" label={t('aud.recovery.link.evidence.label')} error={error('evidenceDocumentId')} hint={t('aud.recovery.link.evidence.help')}>
        <input id="link-evidence" value={form.evidenceDocumentId} onChange={(event) => setForm({ ...form, evidenceDocumentId: event.target.value })} />
      </Field>
      <Field id="link-source-id" label={t('aud.recovery.link.sourceId.label')} error={error('sourceId')} hint={t('aud.recovery.link.sourceId.help')}>
        <input id="link-source-id" value={form.sourceId} onChange={(event) => setForm({ ...form, sourceId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The reversal of a line of the ledger, with the reason in words: a line of the opposite sign is added and nothing is deleted. */
export function ReverseDialog({ line, onClose }: { line: RecoveryLine; onClose(): void }) {
  const { t } = useTranslation();
  const reverse = useReverseRecovery();
  const [form, setForm] = useState<ReverseForm>(EMPTY_REVERSE_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateReverse(form);
  const error = (field: keyof ReverseForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (reverse.isPending || Object.keys(problems).length > 0) return;
    reverse.mutate({ id: line.id, ...reverseBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('aud.recovery.reverse.title', { code: line.code, amount: formatVnd(line.amountVnd) })}
      onClose={onClose}
      refusal={refusalOf(t, reverse)}
      pending={reverse.isPending}
      onSubmit={submit}
    >
      <p className="wide" data-testid="reverse-note">
        {t('aud.recovery.reverse.note')}
      </p>
      <div className="wide">
        <Field id="reverse-reason" label={t('aud.recovery.reverse.reason.label')} error={error('reason')} hint={t('aud.recovery.reverse.reason.help')}>
          <textarea id="reverse-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}
