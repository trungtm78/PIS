import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { useDecideTerm, useGlossaryTerms, useProposeTerm, usePublishTerm, useSubmitTerm } from './hooks';
import { fieldProblemMessage, glossaryStatusLabel, problemMessage } from './labels';
import {
  DISBURSEMENT_DOMAIN,
  EMPTY_GLOSSARY_FORM,
  GLOSSARY_APPROVE_PERMISSION,
  GLOSSARY_PROPOSE_PERMISSION,
  GLOSSARY_STATUS_LIST,
  definitionState,
  describeGlossaryProblem,
  reviseForm,
  validateDecisionReason,
  validateGlossary,
} from './model';
import type { FieldProblem, FormErrors, GlossaryField, GlossaryForm, GlossaryStatus, GlossaryTermView } from './model';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import { toneOfPill } from '../adm/kit-tone';
import '../adm/adm-kit.css';

const NEVER_EMPTY = (): boolean => false;
const OWNER_ID_SHOWN = 8;

type Decision = 'approve' | 'reject' | 'return';
const DECISIONS: readonly Decision[] = ['approve', 'reject', 'return'];
type Translate = ReturnType<typeof useTranslation>['t'];

function decisionLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('mdm.approval.decision.approve.action');
    case 'reject':
      return t('mdm.approval.decision.reject.action');
    case 'return':
      return t('mdm.approval.decision.return.action');
  }
}

const STATUS_PILL: Readonly<Record<GlossaryStatus, string>> = {
  DRAFT: 'pill gray',
  IN_REVIEW: 'pill warn',
  APPROVED: 'pill warn',
  PUBLISHED: 'pill',
  DEPRECATED: 'pill gray',
  REJECTED: 'pill red',
};

/**
 * MDM-34: the glossary of business terms and its approval. A term is proposed, submitted, decided by the owner named on it (never by its
 * proposer) and published; a published term is replaced by the next revision, never edited. The definitions of the disbursement figures are
 * where D03 is signed, so the screen says whether every one of them is published (ST-MDM-008).
 */
export default function GlossaryScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters, the form and the open panels belong to one tenant: a switch starts the screen over.
  return <GlossaryContent key={tenantId ?? 'none'} route={route} />;
}

function GlossaryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const frozen = mode === 'READ_ONLY';
  const mayPropose = holds(GLOSSARY_PROPOSE_PERMISSION) && !frozen;
  const mayApprove = holds(GLOSSARY_APPROVE_PERMISSION) && !frozen;
  const terms = useGlossaryTerms();
  const state = useScreenState({ isLoading: terms.isLoading, error: terms.error, data: terms.data, isEmpty: NEVER_EMPTY });
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState<GlossaryStatus | ''>('');
  const [revising, setRevising] = useState<GlossaryTermView | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const all = terms.data ?? [];
  const rows = all.filter((term) => (domain === '' || term.domain === domain) && (status === '' || term.status === status));
  const domains = [...new Set(all.map((term) => term.domain))].sort();
  const filtering = domain !== '' || status !== '';
  const definitions = definitionState(all, DISBURSEMENT_DOMAIN);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.glossary.page.title')}</h1>
          <p>{t('mdm.glossary.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void terms.refetch()}>
        {definitions === undefined ? null : (
          <SectionCard title={t('mdm.glossary.badge.title')}>
            <div data-testid="definition-badge" data-state={definitions.signed ? 'SIGNED' : 'PENDING'}>
            <p>
              <span className={definitions.signed ? 'pill' : 'pill warn'}>{definitions.signed ? t('mdm.glossary.badge.signed.pill') : t('mdm.glossary.badge.pending.pill')}</span>
            </p>
            <p className="sub">
              {definitions.signed ? t('mdm.glossary.badge.signed.text') : t('mdm.glossary.badge.pending.text', { count: definitions.missing.length, terms: definitions.missing.join(', ') })}
            </p>
            </div>
          </SectionCard>
        )}
        <div className="card">
          <form className="mdm-filters" role="search" onSubmit={(event) => event.preventDefault()} aria-label={t('mdm.glossary.filter.title')}>
            <div className="field">
              <label htmlFor="glossary-domain">{t('mdm.glossary.filter.domain.label')}</label>
              <select id="glossary-domain" value={domain} onChange={(event) => setDomain(event.target.value)}>
                <option value="">{t('mdm.glossary.filter.all.option')}</option>
                {domains.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="glossary-status">{t('mdm.glossary.filter.status.label')}</label>
              <select id="glossary-status" value={status} onChange={(event) => setStatus(event.target.value as GlossaryStatus | '')}>
                <option value="">{t('mdm.glossary.filter.all.option')}</option>
                {GLOSSARY_STATUS_LIST.map((item) => (
                  <option key={item} value={item}>
                    {glossaryStatusLabel(t, item)}
                  </option>
                ))}
              </select>
            </div>
          </form>
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-glossary">
              {filtering ? t('mdm.glossary.noMatch.text') : t('mdm.glossary.empty.text')}
            </p>
          ) : (
            <KitTable caption={t('w2mdm.glossary.table.caption')} aria-label={t('mdm.glossary.table.aria')}>
              <thead>
                <tr>
                  <th>{t('mdm.glossary.code.column')}</th>
                  <th>{t('mdm.glossary.term.column')}</th>
                  <th>{t('mdm.glossary.domain.column')}</th>
                  <th>{t('mdm.glossary.revision.column')}</th>
                  <th>{t('mdm.glossary.status.column')}</th>
                  <th>{t('mdm.glossary.owner.column')}</th>
                  <th>{t('mdm.glossary.effective.column')}</th>
                  <th>{t('mdm.glossary.formula.column')}</th>
                  <th>
                    {t('mdm.glossary.actions.column')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((term) => (
                  <TermRow key={term.id} term={term} mayPropose={mayPropose} mayApprove={mayApprove} onRevise={(term) => { setSaved(false); setRevising(term); }} />
                ))}
              </tbody>
            </KitTable>
          )}
          <p className="sub" data-testid="count">
            {t('mdm.glossary.count.text', { count: rows.length })}
          </p>
        </div>
        {mayPropose ? <ProposeTerm key={revising?.id ?? 'new'} revising={revising} saved={saved} onSaved={setSaved} onDone={() => setRevising(undefined)} /> : null}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.catalogue.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function TermRow({ term, mayPropose, mayApprove, onRevise }: { term: GlossaryTermView; mayPropose: boolean; mayApprove: boolean; onRevise: (term: GlossaryTermView) => void }) {
  const { t } = useTranslation();
  const submit = useSubmitTerm();
  const decide = useDecideTerm();
  const publish = usePublishTerm();
  const [deciding, setDeciding] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const failure = submit.isError ? submit.error : decide.isError ? decide.error : publish.isError ? publish.error : undefined;
  const refused = failure === undefined ? undefined : describeGlossaryProblem(failure);
  const busy = submit.isPending || decide.isPending || publish.isPending;

  const clear = (): void => {
    submit.reset();
    decide.reset();
    publish.reset();
    setNotice(undefined);
  };

  const sendSubmit = (): void => {
    if (busy) return;
    clear();
    submit.mutate({ id: term.id, version: term.version }, { onSuccess: () => setNotice(t('mdm.glossary.submitted.notice')) });
  };

  const sendPublish = (): void => {
    if (busy) return;
    clear();
    publish.mutate({ id: term.id, version: term.version }, { onSuccess: () => setNotice(t('mdm.glossary.published.notice')) });
  };

  const sendDecision = (event: FormEvent, decision: Decision): void => {
    event.preventDefault();
    if (busy) return;
    const found = validateDecisionReason(reason);
    setProblem(found);
    if (found !== undefined) return;
    clear();
    decide.mutate(
      { id: term.id, version: term.version, decision, reason: reason.trim() },
      {
        onSuccess: () => {
          setDeciding(false);
          setReason('');
          setNotice(t('mdm.glossary.decided.notice'));
        },
      },
    );
  };

  return (
    <>
      <tr data-term-id={term.id} data-term-code={term.termCode} data-domain={term.domain} data-revision={term.revision} data-status={term.status}>
        <td>
          <code>{term.termCode}</code>
        </td>
        <td>
          {term.termVi}
          <div className="sub">{term.definition}</div>
          {term.legalBasis === null ? null : <div className="sub">{t('mdm.glossary.legalBasis.text', { basis: term.legalBasis })}</div>}
          {term.decisionReason === null ? null : <div className="sub">{t('mdm.glossary.decisionReason.text', { reason: term.decisionReason })}</div>}
          {term.supersedesId === null ? null : <div className="sub">{t('mdm.glossary.supersedes.text')}</div>}
        </td>
        <td>{term.domain}</td>
        <td>{term.revision}</td>
        <td>
          <StatusPill tone={toneOfPill(STATUS_PILL[term.status])}>{glossaryStatusLabel(t, term.status)}</StatusPill>
        </td>
        <td>
          <code title={term.ownerMembershipId}>{term.ownerMembershipId.slice(0, OWNER_ID_SHOWN)}</code>
        </td>
        <td>{term.effectiveFrom ?? ''}</td>
        <td>{term.formulaRef === null ? null : <code>{term.formulaRef}</code>}</td>
        <td className="row-actions">
          {mayPropose && term.status === 'DRAFT' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={sendSubmit} disabled={busy}>
              {t('mdm.glossary.submit.action')}
            </button>
          ) : null}
          {mayApprove && term.status === 'IN_REVIEW' ? (
            <button
              type="button"
              aria-expanded={deciding}
              onClick={() => {
                clear();
                setDeciding((previous) => !previous);
              }}
            >
              {t('mdm.glossary.decide.action')}
            </button>
          ) : null}
          {mayApprove && term.status === 'APPROVED' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={sendPublish} disabled={busy}>
              {t('mdm.glossary.publish.action')}
            </button>
          ) : null}
          {mayPropose && term.status === 'PUBLISHED' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onRevise(term)}>
              {t('mdm.glossary.revise.action')}
            </button>
          ) : null}
        </td>
      </tr>
      {refused === undefined && notice === undefined ? null : (
        <tr data-term-feedback={term.id}>
          <td colSpan={9}>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert">
                {problemMessage(t, refused)}
              </p>
            )}
            {notice === undefined ? null : (
              <p className="callout" role="status">
                {notice}
              </p>
            )}
          </td>
        </tr>
      )}
      {deciding ? (
        <tr>
          <td colSpan={9}>
            <form onSubmit={(event) => event.preventDefault()} noValidate aria-label={t('mdm.glossary.decide.title', { code: term.termCode })}>
              <Field id={`decision-${term.id}`} label={t('mdm.approval.reason.label')} error={problem === undefined ? undefined : fieldProblemMessage(t, problem)}>
                <textarea
                  id={`decision-${term.id}`}
                  rows={2}
                  value={reason}
                  aria-invalid={problem !== undefined}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setProblem(undefined);
                  }}
                />
              </Field>
              <div className="adm-kit-actions">
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDeciding(false)}>
                  {t('mdm.approval.cancel.action')}
                </button>
                {DECISIONS.map((decision) => (
                  <button key={decision} type="button" className={decision === 'approve' ? 'primary' : undefined} disabled={busy} onClick={(event) => sendDecision(event, decision)}>
                    {decisionLabel(t, decision)}
                  </button>
                ))}
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ProposeTerm({ revising, saved, onSaved, onDone }: { revising: GlossaryTermView | undefined; saved: boolean; onSaved: (saved: boolean) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const propose = useProposeTerm();
  const [form, setForm] = useState<GlossaryForm>(revising === undefined ? EMPTY_GLOSSARY_FORM : reviseForm(revising));
  const [errors, setErrors] = useState<FormErrors<GlossaryField>>({});
  const definition = useRef<HTMLTextAreaElement>(null);
  const refused = propose.isError ? describeGlossaryProblem(propose.error) : undefined;
  // The code and the domain of a revision are those of the term it replaces.
  const fixed = revising !== undefined;

  useEffect(() => {
    // A revision is started from a row far above the form: the cursor goes where the words are changed.
    if (fixed) definition.current?.focus();
  }, [fixed]);

  const setField = (field: GlossaryField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    onSaved(false);
  };
  const error = (field: GlossaryField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (propose.isPending) return;
    const found = validateGlossary(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const formula = form.formulaRef.trim();
    const basis = form.legalBasis.trim();
    propose.mutate(
      {
        term_code: form.termCode.trim(),
        term_vi: form.termVi.trim(),
        definition: form.definition.trim(),
        ...(formula === '' ? {} : { formula_ref: formula }),
        domain: form.domain.trim(),
        owner_membership_id: form.ownerMembershipId.trim().toLowerCase(),
        ...(basis === '' ? {} : { legal_basis: basis }),
        ...(revising === undefined ? {} : { supersedes_id: revising.id }),
      },
      {
        onSuccess: () => {
          setForm(EMPTY_GLOSSARY_FORM);
          onSaved(true);
          onDone();
        },
      },
    );
  };

  const line = (field: GlossaryField, id: string, label: string, readOnly = false, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={form[field]} readOnly={readOnly} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );

  return (
    <form className="card" onSubmit={save} noValidate aria-label={t('mdm.glossary.form.aria')}>
      <h2>{revising === undefined ? t('mdm.glossary.form.title') : t('mdm.glossary.revise.title', { code: revising.termCode, revision: revising.revision })}</h2>
      {revising === undefined ? null : <p className="sub">{t('mdm.glossary.revise.hint')}</p>}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="glossary-saved">
          {t('mdm.glossary.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        {line('termCode', 'glossary-form-code', t('mdm.glossary.form.code.label'), fixed)}
        {line('termVi', 'glossary-form-term', t('mdm.glossary.form.term.label'))}
        {line('domain', 'glossary-form-domain', t('mdm.glossary.form.domain.label'), fixed, t('mdm.glossary.form.domain.hint'))}
        {line('ownerMembershipId', 'glossary-form-owner', t('mdm.glossary.form.owner.label'), false, t('mdm.glossary.form.owner.hint'))}
        {line('formulaRef', 'glossary-form-formula', t('mdm.glossary.form.formula.label'))}
        {line('legalBasis', 'glossary-form-basis', t('mdm.glossary.form.basis.label'))}
      </div>
      <Field id="glossary-form-definition" label={t('mdm.glossary.form.definition.label')} error={error('definition')} hint={t('mdm.glossary.form.definition.hint')}>
        <textarea
          id="glossary-form-definition"
          ref={definition}
          rows={4}
          value={form.definition}
          aria-invalid={error('definition') !== undefined}
          onChange={(event) => setField('definition', event.target.value)}
        />
      </Field>
      <div className="adm-kit-actions">
        {revising === undefined ? null : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onDone}>
            {t('mdm.glossary.revise.cancel.action')}
          </button>
        )}
        <button type="submit" className="ui-button ui-button--primary" disabled={propose.isPending}>
          {t('mdm.glossary.save.action')}
        </button>
      </div>
    </form>
  );
}
