import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useConfirmRule, useCreateRule, usePublishRule, useRetentionRules } from './archive/hooks';
import { classLabel, fieldMessage, problemMessage, ruleSetLabel, ruleStatusLabel, startBasisLabel } from './archive/labels';
import { CLASS_YEARS, EMPTY_CONFIRM, EMPTY_RULE, canConfirmRule, canPublishRule, confirmBody, confirmHasProblems, describeProblem, ruleBody, ruleHasProblems, validateConfirm, validateRule } from './archive/rules';
import type { ConfirmForm, RuleForm } from './archive/rules';
import { APPROVE_RULE_PERMISSION, CONFIRM_RULE_PERMISSION, MANAGE_RULE_PERMISSION, READ_RULE_PERMISSION, RETENTION_CLASSES, RULE_SETS, START_BASES } from './archive/types';
import type { Member, RetentionClass, RetentionRule, RuleSet, StartBasis } from './archive/types';

const DOSSIERS_PATH = '/doc/doc-17';
const NONE = '—';

const memberName = (member: Member | null): string => (member === null ? NONE : (member.name ?? member.id));

/** DOC-18: the retention rules of the tenant (ST-DOC-017, BR-DOC-22). Drafted by one person, published by another and confirmed in law by a third; the periods of one set and category never overlap. */
export default function RetentionRulesScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The form being filled belongs to one tenant: a switch starts the screen over.
  return <RetentionRulesContent key={tenantId ?? 'none'} route={route} />;
}

function RetentionRulesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_RULE_PERMISSION);
  const mayManage = holds(MANAGE_RULE_PERMISSION) && !frozen;
  const mayApprove = holds(APPROVE_RULE_PERMISSION) && !frozen;
  const mayConfirm = holds(CONFIRM_RULE_PERMISSION) && !frozen;
  const list = useRetentionRules(mayRead);
  const create = useCreateRule();
  const publish = usePublishRule();
  const confirm = useConfirmRule();
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [confirmForm, setConfirmForm] = useState<ConfirmForm>(EMPTY_CONFIRM);
  const [confirmAttempted, setConfirmAttempted] = useState(false);
  const rules = list.data ?? [];
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const problems = attempted ? validateRule(form) : {};
  const confirmProblems = confirmAttempted ? validateConfirm(confirmForm) : {};
  const target = confirming === undefined ? undefined : rules.find((rule) => rule.id === confirming);
  const failure = create.isError ? create : publish.isError ? publish : undefined;
  const years = CLASS_YEARS[form.classCode];

  const set = (patch: Partial<RuleForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (create.isPending || ruleHasProblems(validateRule(form))) return;
    create.mutate(ruleBody(form), {
      onSuccess: () => {
        setForm(EMPTY_RULE);
        setAttempted(false);
        setSaved(true);
      },
    });
  };
  const startConfirming = (rule: RetentionRule): void => {
    setConfirming(rule.id);
    setConfirmForm(EMPTY_CONFIRM);
    setConfirmAttempted(false);
  };
  const submitConfirmation = (event: FormEvent): void => {
    event.preventDefault();
    setConfirmAttempted(true);
    if (target === undefined || confirm.isPending || confirmHasProblems(validateConfirm(confirmForm))) return;
    confirm.mutate({ id: target.id, version: target.version, body: confirmBody(confirmForm) }, { onSuccess: () => setConfirming(undefined) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={DOSSIERS_PATH}>
          <span aria-hidden="true">← </span>
          {t('doc.archive.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.archive.rules.title')}</h1>
          <p>{t('doc.archive.rules.subtitle')}</p>
        </div>
      </div>
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.archive.rules.denied')}
        </p>
      ) : (
        <>
          {failure === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {problemMessage(t, describeProblem(failure.error))}
            </p>
          )}
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            <div className="tablewrap">
              <table aria-label={t('doc.archive.rules.aria')} data-testid="rules">
                <thead>
                  <tr>
                    <th scope="col">{t('doc.archive.rules.col.category')}</th>
                    <th scope="col">{t('doc.archive.rules.col.ruleSet')}</th>
                    <th scope="col">{t('doc.archive.rules.col.retention')}</th>
                    <th scope="col">{t('doc.archive.rules.col.period')}</th>
                    <th scope="col">{t('doc.archive.rules.col.status')}</th>
                    <th scope="col">{t('doc.archive.rules.col.confirmation')}</th>
                    <th scope="col">{t('doc.archive.rules.col.people')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('doc.archive.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id} data-rule={rule.id} data-status={rule.status}>
                      <td>{rule.categoryCode}</td>
                      <td>{ruleSetLabel(t, rule.ruleSet)}</td>
                      <td>
                        {classLabel(t, rule.classCode)}
                        {' · '}
                        {t('doc.archive.rules.basis', { basis: startBasisLabel(t, rule.startBasis), months: rule.handoverMonths })}
                      </td>
                      <td>{t('doc.archive.rules.period', { from: rule.effectiveFrom, until: rule.effectiveUntil ?? NONE })}</td>
                      <td>
                        <span className={rule.status === 'PUBLISHED' ? 'pill green' : 'pill gray'}>{ruleStatusLabel(t, rule.status)}</span>
                      </td>
                      <td>{rule.confirmationStatus === 'CONFIRMED' ? t('doc.archive.rules.confirmed', { ref: rule.legalConfirmationRef ?? NONE }) : t('doc.archive.rules.pending')}</td>
                      <td>{t('doc.archive.rules.people', { drafter: memberName(rule.createdBy), publisher: memberName(rule.approvedBy), confirmer: memberName(rule.legalConfirmedBy) })}</td>
                      <td>
                        {mayApprove && canPublishRule(rule, tenant?.membershipId) ? (
                          <button type="button" disabled={publish.isPending} onClick={() => publish.mutate({ id: rule.id, version: rule.version })}>
                            {t('doc.archive.rules.publish.action')}
                          </button>
                        ) : null}
                        {mayConfirm && canConfirmRule(rule, tenant?.membershipId) ? (
                          <button type="button" onClick={() => startConfirming(rule)}>
                            {t('doc.archive.rules.confirm.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </StateBoundary>

          {target === undefined ? null : (
            <form className="card" onSubmit={submitConfirmation} noValidate aria-label={t('doc.archive.rules.confirm.title', { category: target.categoryCode })} data-testid="confirm-form">
              <h2>{t('doc.archive.rules.confirm.title', { category: target.categoryCode })}</h2>
              <p className="sub">{t('doc.archive.rules.confirm.help')}</p>
              {confirm.isError ? (
                <p className="callout warning" role="alert" data-testid="confirm-refusal">
                  {problemMessage(t, describeProblem(confirm.error))}
                </p>
              ) : null}
              <div className="field">
                <label htmlFor="confirm-ref">{t('doc.archive.confirm.ref.label')}</label>
                <input id="confirm-ref" value={confirmForm.reference} aria-invalid={confirmProblems.reference !== undefined} onChange={(event) => setConfirmForm({ ...confirmForm, reference: event.target.value })} />
                {fieldMessage(t, confirmProblems.reference) === undefined ? null : <small role="alert">{fieldMessage(t, confirmProblems.reference)}</small>}
              </div>
              <div className="field">
                <label htmlFor="confirm-evidence">{t('doc.archive.confirm.evidence.label')}</label>
                <input id="confirm-evidence" value={confirmForm.evidenceDocumentId} aria-invalid={confirmProblems.evidenceDocumentId !== undefined} onChange={(event) => setConfirmForm({ ...confirmForm, evidenceDocumentId: event.target.value })} />
                {fieldMessage(t, confirmProblems.evidenceDocumentId) === undefined ? null : <small role="alert">{fieldMessage(t, confirmProblems.evidenceDocumentId)}</small>}
              </div>
              <div className="field">
                <label htmlFor="confirm-note">{t('doc.archive.confirm.note.label')}</label>
                <textarea id="confirm-note" rows={2} value={confirmForm.note} aria-invalid={confirmProblems.note !== undefined} onChange={(event) => setConfirmForm({ ...confirmForm, note: event.target.value })} />
                {fieldMessage(t, confirmProblems.note) === undefined ? null : <small role="alert">{fieldMessage(t, confirmProblems.note)}</small>}
              </div>
              <div className="formfooter">
                <button type="button" onClick={() => setConfirming(undefined)}>
                  {t('doc.archive.action.cancel')}
                </button>
                <button type="submit" className="primary" disabled={confirm.isPending}>
                  {t('doc.archive.rules.confirm.submit')}
                </button>
              </div>
            </form>
          )}

          {mayManage ? (
            <form className="card" onSubmit={submit} noValidate aria-label={t('doc.archive.rules.form.title')}>
              <h2>{t('doc.archive.rules.form.title')}</h2>
              <p className="sub">{t('doc.archive.rules.form.help')}</p>
              {saved ? (
                <p className="callout" role="status" data-testid="saved">
                  {t('doc.archive.rules.form.saved')}
                </p>
              ) : null}
              <div className="field">
                <label htmlFor="rule-set">{t('doc.archive.ruleField.ruleSet.label')}</label>
                <select id="rule-set" value={form.ruleSet} onChange={(event) => set({ ruleSet: event.target.value as RuleSet })}>
                  {RULE_SETS.map((value) => (
                    <option key={value} value={value}>
                      {ruleSetLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rule-category">{t('doc.archive.ruleField.category.label')}</label>
                <input id="rule-category" value={form.categoryCode} aria-invalid={problems.categoryCode !== undefined} onChange={(event) => set({ categoryCode: event.target.value })} />
                <small role={problems.categoryCode === undefined ? undefined : 'alert'}>{fieldMessage(t, problems.categoryCode) ?? t('doc.archive.ruleField.category.hint')}</small>
              </div>
              <div className="field">
                <label htmlFor="rule-class">{t('doc.archive.ruleField.class.label')}</label>
                <select id="rule-class" value={form.classCode} onChange={(event) => set({ classCode: event.target.value as RetentionClass })}>
                  {RETENTION_CLASSES.map((value) => (
                    <option key={value} value={value}>
                      {classLabel(t, value)}
                    </option>
                  ))}
                </select>
                <small data-testid="class-years">{years === null ? t('doc.archive.ruleField.class.permanent') : t('doc.archive.ruleField.class.years', { years })}</small>
              </div>
              <div className="field">
                <label htmlFor="rule-basis-start">{t('doc.archive.ruleField.start.label')}</label>
                <select id="rule-basis-start" value={form.startBasis} onChange={(event) => set({ startBasis: event.target.value as StartBasis })}>
                  {START_BASES.map((value) => (
                    <option key={value} value={value}>
                      {startBasisLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rule-handover">{t('doc.archive.ruleField.handover.label')}</label>
                <input id="rule-handover" inputMode="numeric" value={form.handoverMonths} aria-invalid={problems.handoverMonths !== undefined} onChange={(event) => set({ handoverMonths: event.target.value })} />
                {fieldMessage(t, problems.handoverMonths) === undefined ? null : <small role="alert">{fieldMessage(t, problems.handoverMonths)}</small>}
              </div>
              <div className="field">
                <label htmlFor="rule-precedence">{t('doc.archive.ruleField.precedence.label')}</label>
                <input id="rule-precedence" inputMode="numeric" value={form.precedence} aria-invalid={problems.precedence !== undefined} onChange={(event) => set({ precedence: event.target.value })} />
                {fieldMessage(t, problems.precedence) === undefined ? null : <small role="alert">{fieldMessage(t, problems.precedence)}</small>}
              </div>
              <div className="field">
                <label htmlFor="rule-legal">{t('doc.archive.ruleField.legal.label')}</label>
                <textarea id="rule-legal" rows={2} value={form.legalBasis} aria-invalid={problems.legalBasis !== undefined} onChange={(event) => set({ legalBasis: event.target.value })} />
                {fieldMessage(t, problems.legalBasis) === undefined ? null : <small role="alert">{fieldMessage(t, problems.legalBasis)}</small>}
              </div>
              <div className="field">
                <label htmlFor="rule-from">{t('doc.archive.ruleField.from.label')}</label>
                <input id="rule-from" type="date" value={form.effectiveFrom} aria-invalid={problems.effectiveFrom !== undefined} onChange={(event) => set({ effectiveFrom: event.target.value })} />
                {fieldMessage(t, problems.effectiveFrom) === undefined ? null : <small role="alert">{fieldMessage(t, problems.effectiveFrom)}</small>}
              </div>
              <div className="field">
                <label htmlFor="rule-until">{t('doc.archive.ruleField.until.label')}</label>
                <input id="rule-until" type="date" value={form.effectiveUntil} aria-invalid={problems.effectiveUntil !== undefined} onChange={(event) => set({ effectiveUntil: event.target.value })} />
                <small role={problems.effectiveUntil === undefined ? undefined : 'alert'}>{fieldMessage(t, problems.effectiveUntil) ?? t('doc.archive.ruleField.until.hint')}</small>
              </div>
              <div className="formfooter">
                <button type="submit" className="primary" disabled={create.isPending}>
                  {t('doc.archive.rules.form.submit')}
                </button>
              </div>
            </form>
          ) : null}
        </>
      )}
      <p className="prototype-note">{t('doc.archive.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
