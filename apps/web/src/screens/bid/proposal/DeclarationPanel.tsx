import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { errorIdOf, wireControl } from '../../field-wiring';
import type { TrackedPackage } from '../procurement/model';
import { useContractorOptions, useDecide, useDeclare, useDeclarations } from './hooks';
import { declareProblemMessage, decideProblemMessage, decisionLabel, ownStandingText, problemMessage, standingLabel } from './labels';
import { CONFLICT_DECISIONS, EMPTY_DECIDE, EMPTY_DECLARE, MAX_RELATION, declareBody, decideBody, describeProblem, momentText, validateDecide, validateDeclare } from './model';
import type { ConflictDecision, DecideForm, Declaration, DeclareForm } from './model';
import '../bid.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '\u00d7';

interface DeclareDialogProps {
  pack: TrackedPackage;
  onClose(): void;
}

/** The declaration of the signed-in member: asked as a question and never assumed, with the relation in words and, when there is one, the contractor it is with. */
function DeclareDialog({ pack, onClose }: DeclareDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const contractors = useContractorOptions(true);
  const declare = useDeclare();
  const [form, setForm] = useState<DeclareForm>(EMPTY_DECLARE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDeclare(form);
  const relationProblem = submitted && problems.relation !== undefined ? declareProblemMessage(t, problems.relation) : undefined;
  const answerProblem = submitted && problems.hasConflict !== undefined ? declareProblemMessage(t, problems.hasConflict) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (declare.isPending || Object.keys(problems).length > 0) return;
    declare.mutate({ packageId: pack.id, body: declareBody(form) }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('bid.conflict.declare.title', { code: pack.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.conflict.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <form onSubmit={submit} noValidate>
            {declare.isError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(declare.error))}
              </p>
            ) : null}
            <fieldset className="field" data-field="declare-answer">
              <legend>{t('bid.conflict.declare.question')}</legend>
              <label>
                <input type="radio" name="declare-answer" checked={form.hasConflict === false} onChange={() => setForm({ ...EMPTY_DECLARE, hasConflict: false })} />
                {t('bid.conflict.declare.no')}
              </label>
              <label>
                <input type="radio" name="declare-answer" checked={form.hasConflict === true} onChange={() => setForm({ ...form, hasConflict: true })} />
                {t('bid.conflict.declare.yes')}
              </label>
              {answerProblem === undefined ? null : (
                <small role="alert" className="field-error">
                  {answerProblem}
                </small>
              )}
            </fieldset>
            {form.hasConflict !== true ? null : (
              <div className="formgrid">
                <div className="field" data-field="declare-relation">
                  <label htmlFor="declare-relation">{t('bid.conflict.field.relation')}</label>
                  {wireControl(
                    <textarea id="declare-relation" rows={4} maxLength={MAX_RELATION} value={form.relation} onChange={(event) => setForm({ ...form, relation: event.target.value })} />,
                    'declare-relation',
                    { hint: false, error: relationProblem !== undefined },
                  )}
                  {relationProblem === undefined ? null : (
                    <small role="alert" className="field-error" id={errorIdOf('declare-relation')}>
                      {relationProblem}
                    </small>
                  )}
                </div>
                <div className="field" data-field="declare-contractor">
                  <label htmlFor="declare-contractor">{t('bid.conflict.field.contractor')}</label>
                  <select id="declare-contractor" value={form.contractorId} onChange={(event) => setForm({ ...form, contractorId: event.target.value })}>
                    <option value="">{t('bid.conflict.field.contractor.whole')}</option>
                    {(contractors.data ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.legalName}
                      </option>
                    ))}
                  </select>
                  <small className="sub">{t('bid.conflict.field.contractor.hint')}</small>
                </div>
              </div>
            )}
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('bid.conflict.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={declare.isPending}>
                {declare.isPending ? t('bid.conflict.declare.pending') : t('bid.conflict.declare.submit')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

interface DecisionDialogProps {
  pack: TrackedPackage;
  declaration: Declaration;
  onClose(): void;
}

/** The decision on a declaration, under the version the decider saw: allowed, recused or blocked, with the reasons in words. */
function DecisionDialog({ pack, declaration, onClose }: DecisionDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const decide = useDecide();
  const [form, setForm] = useState<DecideForm>(EMPTY_DECIDE);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecide(form);
  const decisionProblem = submitted && problems.decision !== undefined ? decideProblemMessage(t, problems.decision) : undefined;
  const reasonProblem = submitted && problems.reason !== undefined ? decideProblemMessage(t, problems.reason) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ declarationId: declaration.id, version: declaration.version, body: decideBody(form) }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('bid.conflict.decide.title', { code: pack.code, name: declaration.memberName })}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.conflict.dialog.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <form onSubmit={submit} noValidate>
            {decide.isError ? (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(decide.error))}
              </p>
            ) : null}
            <p data-testid="decision-relation">{t('bid.conflict.decide.relation', { text: declaration.relationText ?? '' })}</p>
            <div className="formgrid">
              <div className="field" data-field="decide-decision">
                <label htmlFor="decide-decision">{t('bid.conflict.field.decision')}</label>
                {wireControl(
                  <select id="decide-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value as ConflictDecision | '' })}>
                    <option value="">{t('bid.conflict.field.decision.choose')}</option>
                    {CONFLICT_DECISIONS.map((decision) => (
                      <option key={decision} value={decision}>
                        {decisionLabel(t, decision)}
                      </option>
                    ))}
                  </select>,
                  'decide-decision',
                  { hint: false, error: decisionProblem !== undefined },
                )}
                {decisionProblem === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('decide-decision')}>
                    {decisionProblem}
                  </small>
                )}
              </div>
              <div className="field" data-field="decide-reason">
                <label htmlFor="decide-reason">{t('bid.conflict.field.reason')}</label>
                {wireControl(
                  <textarea id="decide-reason" rows={4} maxLength={MAX_RELATION} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />,
                  'decide-reason',
                  { hint: false, error: reasonProblem !== undefined },
                )}
                {reasonProblem === undefined ? null : (
                  <small role="alert" className="field-error" id={errorIdOf('decide-reason')}>
                    {reasonProblem}
                  </small>
                )}
              </div>
            </div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('bid.conflict.dialog.cancel')}
              </button>
              <button type="submit" className="primary" disabled={decide.isPending}>
                {decide.isPending ? t('bid.conflict.decide.pending') : t('bid.conflict.decide.submit')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

export interface DeclarationPanelProps {
  pack: TrackedPackage;
  /** The caller evaluates proposals and the session is not read-only. */
  mayEvaluate: boolean;
}

/**
 * The declaration of conflict of interest of a package (BID-05, BR-BID-03). A member of the evaluation team is told, before anything else, that the proposals stay closed to them until
 * they declare; whoever decides sees every declaration of the package with the words of the relation and decides the ones that name a conflict (never their own).
 */
export function DeclarationPanel({ pack, mayEvaluate }: DeclarationPanelProps) {
  const { t } = useTranslation();
  const declarations = useDeclarations(pack.id);
  const [declaring, setDeclaring] = useState(false);
  const [deciding, setDeciding] = useState<Declaration | undefined>(undefined);
  if (declarations.isError) {
    return (
      <article className="card" data-testid="conflict-panel">
        <h2>{t('bid.conflict.panel.title')}</h2>
        <p className="callout warning" role="alert" data-testid="conflict-error">
          {t('bid.conflict.error.load')}
        </p>
      </article>
    );
  }
  if (declarations.data === undefined) return null;
  const own = declarations.data.items.find((item) => item.own);
  const mayDecide = declarations.data.mayDecide;
  if (!mayEvaluate && !mayDecide && own === undefined) return null;
  return (
    <article className="card" data-testid="conflict-panel" aria-label={t('bid.conflict.panel.title')}>
      <h2>{t('bid.conflict.panel.title')}</h2>
      {own === undefined && mayEvaluate ? (
        <div className="callout warning" role="status" data-testid="conflict-banner">
          <p>{t('bid.conflict.required.notice')}</p>
          <button type="button" className="button primary" onClick={() => setDeclaring(true)}>
            {t('bid.conflict.declare.action')}
          </button>
        </div>
      ) : null}
      {own === undefined ? null : (
        <p className={own.standing === 'CLEAR' || own.standing === 'ALLOWED' ? 'callout' : 'callout warning'} role="status" data-testid="own-standing">
          {ownStandingText(t, own.standing)}
        </p>
      )}
      {!mayDecide ? null : (
        <table className="table" data-testid="declarations">
          <thead>
            <tr>
              <th scope="col">{t('bid.conflict.column.member')}</th>
              <th scope="col">{t('bid.conflict.column.relation')}</th>
              <th scope="col">{t('bid.conflict.column.contractor')}</th>
              <th scope="col">{t('bid.conflict.column.declared')}</th>
              <th scope="col">{t('bid.conflict.column.standing')}</th>
              <th scope="col">{t('bid.conflict.column.action')}</th>
            </tr>
          </thead>
          <tbody>
            {declarations.data.items.map((item) => (
              <tr key={item.id} data-declaration-id={item.id} data-standing={item.standing}>
                <th scope="row">{item.memberName}</th>
                <td>{item.hasConflict ? item.relationText : t('bid.conflict.none.text')}</td>
                <td>{item.contractorName ?? (item.hasConflict ? t('bid.conflict.whole.text') : '')}</td>
                <td>{momentText(item.declaredAt)}</td>
                <td>
                  <span className={item.standing === 'CLEAR' || item.standing === 'ALLOWED' ? 'bid-badge ok' : 'bid-badge'}>{standingLabel(t, item.standing)}</span>
                </td>
                <td>
                  {!item.hasConflict ? null : item.own ? (
                    <span className="sub" data-testid="own-note">
                      {t('bid.conflict.own.note')}
                    </span>
                  ) : (
                    <button type="button" className="button" aria-label={t('bid.conflict.decide.aria', { name: item.memberName })} onClick={() => setDeciding(item)}>
                      {item.decision === null ? t('bid.conflict.decide.action') : t('bid.conflict.decide.again')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {declaring ? <DeclareDialog pack={pack} onClose={() => setDeclaring(false)} /> : null}
      {deciding === undefined ? null : <DecisionDialog pack={pack} declaration={deciding} onClose={() => setDeciding(undefined)} />}
    </article>
  );
}
