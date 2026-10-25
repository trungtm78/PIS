import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import { commandProblemMessage } from '../labels';
import { describeProblem } from '../model';
import { useRecordHandover } from './hooks';
import { handoverProblemMessage } from './labels';
import { emptyHandover, handoverBody, remainingText, validateHandover } from './model';
import type { HandoverForm, SectionLine } from './model';
import '../lnd.css';

interface HandoverDialogProps {
  section: SectionLine;
  contractCode: string;
  today: string;
  onClose(): void;
}

/**
 * The handover of land to the contract of a section: the whole area handed over by now (it only grows and never passes what the section needs), the day, and the document that
 * records the handover. The server judges the contract (active, and one that builds), the parcels of the last of the area, and the document.
 */
export function HandoverDialog({ section, contractCode, today, onClose }: HandoverDialogProps) {
  const { t } = useTranslation();
  const handover = useRecordHandover();
  const [form, setForm] = useState<HandoverForm>(emptyHandover(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateHandover(form, section, today);
  const error = (field: keyof HandoverForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? handoverProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (handover.isPending || Object.keys(problems).length > 0) return;
    handover.mutate({ id: section.id, version: section.version, body: handoverBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.sections.handover.title', { code: section.code })}
      onClose={onClose}
      refusal={handover.isError ? commandProblemMessage(t, describeProblem(handover.error)) : undefined}
      pending={handover.isPending}
      onSubmit={submit}
    >
      <p className="sub" data-testid="handover-summary">
        {t('lnd.sections.handover.summary', { contract: contractCode, handed: section.handedAreaM2, required: section.requiredAreaM2, remaining: remainingText(section) })}
      </p>
      <Field id="handover-area" label={t('lnd.sections.handover.area.label')} error={error('handedAreaM2')} hint={t('lnd.sections.handover.area.hint')}>
        <input id="handover-area" inputMode="decimal" autoComplete="off" value={form.handedAreaM2} onChange={(event) => setForm({ ...form, handedAreaM2: event.target.value })} />
      </Field>
      <Field id="handover-day" label={t('lnd.sections.handover.day.label')} error={error('handedOverOn')}>
        <input id="handover-day" type="date" value={form.handedOverOn} onChange={(event) => setForm({ ...form, handedOverOn: event.target.value })} />
      </Field>
      <Field id="handover-document" label={t('lnd.sections.handover.document.label')} error={error('documentVersionId')} hint={t('lnd.sections.handover.document.hint')}>
        <input id="handover-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
