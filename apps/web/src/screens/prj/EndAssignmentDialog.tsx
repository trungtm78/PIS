import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { useEndAssignment } from './accountability-commands';
import { formProblemMessage, problemMessage } from './accountability-labels';
import { EMPTY_END, describeProblem, endBody, validateEnd, vietnamToday } from './accountability-model';
import type { AssignmentLine, EndForm } from './accountability-model';
import { Field } from './components';
import './prj.css';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '×';

export interface EndAssignmentDialogProps {
  line: AssignmentLine;
  onClose(): void;
}

/**
 * Ends an assignment with a day and a reason (PRJ-17): the row stays with its history, a new assignment is made for whoever takes over. The command is
 * sent against the version the register showed (If-Match).
 */
export function EndAssignmentDialog({ line, onClose }: EndAssignmentDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const end = useEndAssignment();
  const [form, setForm] = useState<EndForm>(EMPTY_END);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateEnd(form, vietnamToday(), line.validFrom);
  const refused = end.isError ? describeProblem(end.error) : undefined;
  const error = (field: keyof EndForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (end.isPending || Object.keys(problems).length > 0) return;
    end.mutate({ id: line.id, version: line.version, body: endBody(form) }, { onSuccess: onClose });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.accountability.end.title', { project: line.projectCode })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.accountability.end.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="prj-dialog-body">
          <form onSubmit={submit} noValidate>
            <p data-testid="end-current">{t('prj.accountability.end.current.text', { leader: line.leaderName ?? line.leaderMembershipId, from: line.validFrom })}</p>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="end-refusal">
                {problemMessage(t, refused)}
              </p>
            )}
            <div className="formgrid">
              <Field id="end-until" label={t('prj.accountability.end.until.label')} error={error('validUntil')} hint={t('prj.accountability.end.until.help')}>
                <input id="end-until" type="date" value={form.validUntil} onChange={(event) => setForm({ ...form, validUntil: event.target.value })} />
              </Field>
              <Field id="end-reason" label={t('prj.accountability.end.reason.label')} error={error('reason')}>
                <textarea id="end-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
              </Field>
            </div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('prj.accountability.end.cancel.action')}
              </button>
              <button type="submit" className="primary" disabled={end.isPending}>
                {end.isPending ? t('prj.accountability.end.submit.pending') : t('prj.accountability.end.submit.action')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
