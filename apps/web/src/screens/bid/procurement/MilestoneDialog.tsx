import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { errorIdOf, wireControl } from '../../field-wiring';
import { useRecordMilestone } from './hooks';
import { fieldProblemMessage, milestoneLabel, problemMessage } from './labels';
import { EMPTY_MILESTONE_FORM, MILESTONE_KINDS, describeProblem, formOf, milestoneBody, validateMilestone } from './model';
import type { MilestoneForm, MilestoneKind, MilestoneLine, TrackedPackage } from './model';
import '../bid.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

export interface MilestoneDialogProps {
  pack: TrackedPackage;
  /** The milestone being corrected, or undefined to record a kind that has no date yet. */
  line: MilestoneLine | undefined;
  /** The milestones the package holds, to start the form from the dates of the kind chosen. */
  held: readonly MilestoneLine[];
  onClose(): void;
}

/**
 * The record of a milestone of a package (BID-17): the kind, the planned date and the actual date, read as Vietnam time. A kind that already has dates starts the form from them,
 * and a date left empty keeps the date the package holds. The version of the package the screen read travels as the If-Match; the server judges the order of the dates.
 */
export function MilestoneDialog({ pack, line, held, onClose }: MilestoneDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const record = useRecordMilestone();
  const [form, setForm] = useState<MilestoneForm>(line === undefined ? EMPTY_MILESTONE_FORM : formOf(line));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateMilestone(form, new Date());
  const error = (field: keyof MilestoneForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? fieldProblemMessage(t, problem) : undefined;
  };
  const choose = (kind: MilestoneKind | ''): void => {
    const existing = held.find((candidate) => candidate.kind === kind);
    setForm(existing === undefined ? { ...EMPTY_MILESTONE_FORM, kind } : formOf(existing));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ packageId: pack.id, version: pack.version, body: milestoneBody(form) }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('bid.milestone.dialog.title', { code: pack.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.milestone.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <form onSubmit={submit} noValidate>
            {record.isError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(record.error))}
              </p>
            ) : null}
            <div className="formgrid">
              <div className="field" data-field="milestone-kind">
                <label htmlFor="milestone-kind">{t('bid.milestone.field.kind')}</label>
                {wireControl(
                  <select id="milestone-kind" disabled={line !== undefined} value={form.kind} onChange={(event) => choose(event.target.value as MilestoneKind | '')}>
                    <option value="">{t('bid.milestone.field.choose')}</option>
                    {MILESTONE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {milestoneLabel(t, kind)}
                      </option>
                    ))}
                  </select>,
                  'milestone-kind',
                  { hint: false, error: error('kind') !== undefined },
                )}
                {error('kind') === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('milestone-kind')}>
                    {error('kind')}
                  </small>
                )}
              </div>
              <div className="field" data-field="milestone-planned">
                <label htmlFor="milestone-planned">{t('bid.milestone.field.planned')}</label>
                {wireControl(
                  <input id="milestone-planned" type="datetime-local" value={form.plannedAt} onChange={(event) => setForm({ ...form, plannedAt: event.target.value })} />,
                  'milestone-planned',
                  { hint: false, error: error('plannedAt') !== undefined },
                )}
                {error('plannedAt') === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('milestone-planned')}>
                    {error('plannedAt')}
                  </small>
                )}
              </div>
              <div className="field" data-field="milestone-actual">
                <label htmlFor="milestone-actual">{t('bid.milestone.field.actual')}</label>
                {wireControl(
                  <input id="milestone-actual" type="datetime-local" value={form.actualAt} onChange={(event) => setForm({ ...form, actualAt: event.target.value })} />,
                  'milestone-actual',
                  { hint: false, error: error('actualAt') !== undefined },
                )}
                {error('actualAt') === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('milestone-actual')}>
                    {error('actualAt')}
                  </small>
                )}
              </div>
            </div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('bid.milestone.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={record.isPending}>
                {record.isPending ? t('bid.milestone.dialog.pending') : t('bid.milestone.dialog.submit')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}
