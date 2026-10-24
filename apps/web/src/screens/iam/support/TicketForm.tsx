import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from './components';
import { useCreateTicket } from './hooks';
import { categoryLabel, fieldMessage, problemMessage } from './labels';
import { CATEGORIES, DESCRIPTION_MAX, EMPTY_FORM, SUBJECT_MAX, describeProblem, hasErrors, ticketBody, validateTicket } from './model';
import type { Category, TicketErrors, TicketField, TicketForm as TicketFormValue } from './model';

export interface TicketFormProps {
  /** Told with the id of the ticket once it is raised, so the list can say its code. */
  onRaised: (ticketId: string | undefined) => void;
}

/**
 * The form that raises a support ticket (IAM-08): what it is about, a subject and the words of the trouble. The priority and the time for an answer are the
 * server's (they come from what the ticket is about, not from what the member would like), and what the member writes stays in their tenant: the operator of
 * the platform is shown the subject and the SLA, not the description.
 */
export function TicketForm({ onRaised }: TicketFormProps) {
  const { t } = useTranslation();
  const create = useCreateTicket();
  const [form, setForm] = useState<TicketFormValue>(EMPTY_FORM);
  const [errors, setErrors] = useState<TicketErrors>({});
  const refused = create.isError ? describeProblem(create.error) : undefined;

  const touch = (): void => {
    if (create.isError) create.reset();
  };
  const setField = <Name extends 'subject' | 'description'>(field: Name, value: TicketFormValue[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    touch();
  };
  const message = (field: TicketField): string | undefined => {
    const problem = errors[field];
    if (problem !== undefined) return fieldMessage(t, field, problem);
    return refused?.field === field ? t('iam.support.field.rejected.error') : undefined;
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateTicket(form);
    setErrors(found);
    if (hasErrors(found)) return;
    create.mutate(ticketBody(form), {
      onSuccess: (result) => {
        setForm({ ...EMPTY_FORM, category: form.category });
        onRaised(result.resource_id);
      },
    });
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('iam.support.form.aria')}>
      <h2>{t('iam.support.form.title')}</h2>
      <p className="sub">{t('iam.support.form.hint')}</p>
      {refused === undefined || refused.field !== undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem" data-reason={refused.reason}>
          {problemMessage(t, refused)}
        </p>
      )}
      <Field id="support-category" label={t('iam.support.form.category.label')} error={undefined} hint={t('iam.support.form.category.hint')}>
        <select
          id="support-category"
          value={form.category}
          onChange={(event) => {
            setForm((previous) => ({ ...previous, category: event.target.value as Category }));
            touch();
          }}
        >
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(t, category)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="support-subject" label={t('iam.support.form.subject.label')} error={message('subject')} hint={t('iam.support.form.subject.hint', { max: SUBJECT_MAX })}>
        <input id="support-subject" value={form.subject} onChange={(event) => setField('subject', event.target.value)} />
      </Field>
      <Field id="support-description" label={t('iam.support.form.description.label')} error={message('description')} hint={t('iam.support.form.description.hint', { max: DESCRIPTION_MAX })}>
        <textarea id="support-description" rows={6} value={form.description} onChange={(event) => setField('description', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={create.isPending}>
          {create.isPending ? t('iam.support.form.sending') : t('iam.support.form.send.action')}
        </button>
      </div>
    </form>
  );
}
