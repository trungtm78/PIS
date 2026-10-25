import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../components';
import { amountText } from '../model';
import { CommandFrame } from '../../qms/CommandFrame';
import { useReleaseRetention } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import { describeProblem, emptyRelease, releaseBody, validateRelease } from './model';
import type { HoldLine, ReleaseForm } from './model';

/**
 * Releasing the retention of one BOQ item: the amount (at most what is still held), the reason and, when the condition is a decision of the authority, the document of the decision. The server judges
 * the condition, the amount and who is asking again.
 */
export function ReleaseDialog({ hold, onClose }: { hold: HoldLine; onClose(): void }) {
  const { t, locale } = useTranslation();
  const release = useReleaseRetention();
  const [form, setForm] = useState<ReleaseForm>(emptyRelease(hold));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRelease(form, hold);
  const shown = (field: keyof ReleaseForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<ReleaseForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (release.isPending || Object.keys(problems).length > 0) return;
    release.mutate({ id: hold.id, version: hold.version, body: releaseBody(form) }, { onSuccess: onClose });
  };
  const words = { close: t('ctr.retention.dialog.close'), cancel: t('ctr.retention.dialog.cancel'), pending: t('ctr.retention.dialog.pending') };
  return (
    <CommandFrame
      title={t('ctr.retention.release.title', { item: hold.item.key })}
      refusal={release.isError ? problemMessage(t, describeProblem(release.error), locale) : undefined}
      pending={release.isPending}
      submitLabel={t('ctr.retention.release.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="callout" role="note" data-testid="left">
        {t('ctr.retention.release.left', { left: amountText(hold.leftVnd, locale) })}
      </p>
      <Field id="release-amount" label={t('ctr.retention.field.amount')} error={shown('amount')} hint={t('ctr.retention.field.amount.hint')}>
        <input id="release-amount" inputMode="numeric" autoComplete="off" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field id="release-reason" label={t('ctr.retention.field.reason')} error={shown('reason')}>
        <textarea id="release-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      <Field id="release-decision" label={t('ctr.retention.field.decision')} error={shown('decision')} hint={t('ctr.retention.field.decision.hint')}>
        <input id="release-decision" autoComplete="off" value={form.decision} onChange={(event) => set({ decision: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
