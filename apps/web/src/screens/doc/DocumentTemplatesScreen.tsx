import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { CreateRevisionForm } from './templates/CreateRevisionForm';
import { useConfirmTemplate, usePublishTemplate, useRetireTemplate, useTemplates } from './templates/hooks';
import type { TemplateFilter } from './templates/hooks';
import { fieldProblemMessage, groupLabel, problemMessage, statusLabel } from './templates/labels';
import { actionsFor, cxnTags, matchesText } from './templates/model';
import { describeProblem } from './templates/problems';
import { EMPTY_CONFIRMATION, confirmationBody, reasonProblem, validateConfirmation } from './templates/rules';
import type { ConfirmationErrors, ConfirmationValues } from './templates/rules';
import { APPROVE_TEMPLATES_PERMISSION, CONFIRM_TEMPLATES_PERMISSION, MANAGE_TEMPLATES_PERMISSION, TEMPLATE_GROUPS, TEMPLATE_STATUSES } from './templates/types';
import type { Template, TemplateGroup, TemplateStatus } from './templates/types';
import './templates/templates.css';

type PanelKind = 'publish' | 'legal' | 'retire';

interface Panel {
  kind: PanelKind;
  template: Template;
}

interface Filter extends TemplateFilter {
  text: string;
}

const EMPTY_FILTER: Filter = { text: '', group: '', status: '', asOf: '' };

/** DOC-14: the template library, with effective dating and the three separate steps: draft, publish, legal confirmation. */
export default function DocumentTemplatesScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters, the open panel and the drafts of its fields belong to one tenant: a switch starts the screen over.
  return <DocumentTemplatesContent key={tenantId ?? 'none'} route={route} />;
}

function DocumentTemplatesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const context = { membershipId: tenant?.membershipId, permissions, frozen, manage: MANAGE_TEMPLATES_PERMISSION, approve: APPROVE_TEMPLATES_PERMISSION, confirmLegal: CONFIRM_TEMPLATES_PERMISSION };
  const [draft, setDraft] = useState<Filter>(EMPTY_FILTER);
  const [applied, setApplied] = useState<Filter>(EMPTY_FILTER);
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [values, setValues] = useState<ConfirmationValues>(EMPTY_CONFIRMATION);
  const [errors, setErrors] = useState<ConfirmationErrors>({});
  const [reason, setReason] = useState('');
  const [reasonRefused, setReasonRefused] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const mayCreate = !frozen && (permissions === undefined || permissions.includes(MANAGE_TEMPLATES_PERMISSION));
  const list = useTemplates({ group: applied.group, status: applied.status, asOf: applied.asOf });
  const publish = usePublishTemplate();
  const confirm = useConfirmTemplate();
  const retire = useRetireTemplate();
  const all = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const shown = useMemo(() => all.filter((template) => matchesText(template, applied.text)), [all, applied.text]);
  // The state replaces the table, not the filters: a filter without revisions can still be changed.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : all });
  const active = panel?.kind === 'publish' ? publish : panel?.kind === 'legal' ? confirm : retire;
  const problem = panel !== undefined && active.isError ? describeProblem(active.error) : undefined;
  const pending = publish.isPending || confirm.isPending || retire.isPending;

  const submitFilter = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
  };

  const open = (kind: PanelKind, template: Template): void => {
    publish.reset();
    confirm.reset();
    retire.reset();
    setDone(undefined);
    setValues(EMPTY_CONFIRMATION);
    setErrors({});
    setReason('');
    setReasonRefused(false);
    setPanel({ kind, template });
  };

  const finish = (message: string): void => {
    setPanel(undefined);
    setDone(message);
  };

  const submitPanel = (event: FormEvent): void => {
    event.preventDefault();
    if (panel === undefined || pending) return;
    const { template } = panel;
    const input = { templateId: template.id, version: template.version };
    if (panel.kind === 'publish') {
      publish.mutate(input, { onSuccess: () => finish(t('doc.templates.publish.done.notice', { code: template.templateCode })) });
    } else if (panel.kind === 'legal') {
      const found = validateConfirmation(values);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
      confirm.mutate({ ...input, body: confirmationBody(values) }, { onSuccess: () => finish(t('doc.templates.legal.done.notice', { code: template.templateCode })) });
    } else {
      if (reasonProblem(reason) !== undefined) {
        setReasonRefused(true);
        return;
      }
      retire.mutate({ ...input, reason: reason.trim() }, { onSuccess: () => finish(t('doc.templates.retire.done.notice', { code: template.templateCode })) });
    }
  };

  const setField = (field: keyof ConfirmationValues, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const confirmationPill = (template: Template) =>
    template.confirmationStatus === 'CONFIRMED' ? (
      <span className="pill" data-confirmation="confirmed">
        {t('doc.templates.confirmation.confirmed')}
      </span>
    ) : (
      <span className="pill warn" data-confirmation="pending">
        {t('doc.templates.confirmation.pending', { tags: cxnTags(template) })}
      </span>
    );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.templates.page.title')}</h1>
          <p>{t('doc.templates.page.subtitle')}</p>
        </div>
        {mayCreate && !creating ? (
          <div className="actions">
            <button type="button" className="primary" data-testid="template-create-open" onClick={() => { setDone(undefined); setCreating(true); }}>
              {t('misc.tpl.open')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout">{t('doc.templates.rule.notice')}</p>
      {done === undefined ? null : (
        <p className="callout" role="status">
          {done}
        </p>
      )}
      {creating && mayCreate ? (
        <CreateRevisionForm
          asOf={new Date().toISOString().slice(0, 10)}
          onCancel={() => setCreating(false)}
          onCreated={(code) => {
            setCreating(false);
            setDone(t('misc.tpl.created', { code }));
          }}
        />
      ) : null}
      <div className="card">
        <form className="filters" onSubmit={submitFilter} noValidate>
          <div>
            <label htmlFor="template-search">{t('doc.templates.search.label')}</label>
            <input id="template-search" type="search" value={draft.text} placeholder={t('doc.templates.search.placeholder')} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          </div>
          <div>
            <label htmlFor="template-group">{t('doc.templates.group.label')}</label>
            <select id="template-group" value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value as TemplateGroup | '' })}>
              <option value="">{t('doc.templates.group.all')}</option>
              {TEMPLATE_GROUPS.map((group) => (
                <option key={group} value={group}>
                  {groupLabel(t, group)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="template-status">{t('doc.templates.filterStatus.label')}</label>
            <select id="template-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as TemplateStatus | '' })}>
              <option value="">{t('doc.templates.filterStatus.all')}</option>
              {TEMPLATE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="template-as-of">{t('doc.templates.asOf.label')}</label>
            <input id="template-as-of" type="date" value={draft.asOf} onChange={(event) => setDraft({ ...draft, asOf: event.target.value })} />
            <small className="sub">{t('doc.templates.asOf.hint')}</small>
          </div>
          <button type="submit">{t('doc.templates.filter.action')}</button>
        </form>
        {frozen ? (
          <p className="callout warning" role="status">
            {t('doc.templates.frozen.notice')}
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('doc.templates.col.template')}</th>
                  <th>{t('doc.templates.col.group')}</th>
                  <th>{t('doc.templates.col.form')}</th>
                  <th>{t('doc.templates.col.legal')}</th>
                  <th>{t('doc.templates.col.effective')}</th>
                  <th>{t('doc.templates.col.legalStatus')}</th>
                  <th>{t('doc.templates.col.module')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((template) => {
                  const actions = actionsFor(template, context);
                  return (
                    <tr key={template.id} data-template-id={template.id} className={template.id === panel?.template.id ? 'selected' : undefined}>
                      <td>
                        <strong>{template.templateCode}</strong> <span className="pill gray">{t('doc.templates.revision.pill', { revision: template.revision })}</span>
                        <div className="sub">{template.title}</div>
                      </td>
                      <td>{groupLabel(t, template.groupCode)}</td>
                      <td>{template.formCode ?? '–'}</td>
                      <td className="template-legal">
                        <div>{template.legalBasis}</div>
                        <div className="sub">{template.origin === 'PLATFORM_PACK' ? t('doc.templates.origin.pack', { version: template.packVersion ?? '' }) : t('doc.templates.origin.tenant')}</div>
                      </td>
                      <td>
                        {template.effectiveUntil === null
                          ? t('doc.templates.period.open', { from: template.effectiveFrom })
                          : t('doc.templates.period.closed', { from: template.effectiveFrom, until: template.effectiveUntil })}
                      </td>
                      <td>
                        <div className="template-badges">
                          <span className={template.status === 'RETIRED' ? 'pill red' : template.status === 'PUBLISHED' ? 'pill' : 'pill gray'} data-lifecycle={template.status}>
                            {statusLabel(t, template.status)}
                          </span>
                          {template.status === 'RETIRED' ? null : confirmationPill(template)}
                        </div>
                        {template.confirmationStatus === 'CONFIRMED' && template.legalConfirmationRef !== null ? (
                          <div className="sub">{t('doc.templates.confirmation.reference', { reference: template.legalConfirmationRef })}</div>
                        ) : null}
                        {template.status !== 'RETIRED' && template.confirmationStatus === 'PENDING_CONFIRMATION' && template.watermarkText !== null ? (
                          <div className="sub">{t('doc.templates.watermark.text', { text: template.watermarkText })}</div>
                        ) : null}
                        {template.status === 'PUBLISHED' && template.confirmationStatus === 'CONFIRMED' && template.layoutConfirmationStatus === 'PENDING_CONFIRMATION' ? (
                          <div className="sub">{t('doc.templates.layout.pending')}</div>
                        ) : null}
                      </td>
                      <td>{template.sourceModule ?? '–'}</td>
                      <td className="row-actions">
                        <Link to={`/doc/doc-15?id=${template.id}`} aria-label={t('doc.templates.compare.label', { code: template.templateCode, revision: template.revision })}>
                          {t('doc.templates.compare.action')}
                        </Link>
                        {actions.publish ? (
                          <button type="button" aria-label={t('doc.templates.publish.label', { code: template.templateCode, revision: template.revision })} onClick={() => open('publish', template)}>
                            {t('doc.templates.publish.action')}
                          </button>
                        ) : null}
                        {actions.publishNeedsOther ? <span className="sub">{t('doc.templates.publish.other.hint')}</span> : null}
                        {actions.confirm ? (
                          <button type="button" aria-label={t('doc.templates.legal.label', { code: template.templateCode, revision: template.revision })} onClick={() => open('legal', template)}>
                            {t('doc.templates.legal.action')}
                          </button>
                        ) : null}
                        {actions.confirmNeedsOther ? <span className="sub">{t('doc.templates.legal.other.hint')}</span> : null}
                        {actions.retire ? (
                          <button type="button" aria-label={t('doc.templates.retire.label', { code: template.templateCode, revision: template.revision })} onClick={() => open('retire', template)}>
                            {t('doc.templates.retire.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {shown.length === 0 ? <p className="muted">{t('doc.templates.filtered.empty')}</p> : null}
          <div className="row between gap tiny muted">
            <span>{t('doc.templates.count.text', { count: shown.length })}</span>
            {list.hasNextPage ? (
              <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('doc.templates.more.action')}
              </button>
            ) : null}
          </div>
        </StateBoundary>
      </div>
      {panel === undefined || frozen ? null : (
        <form className="card" onSubmit={submitPanel} noValidate aria-label={panelTitle(t, panel)}>
          <h2>{panelTitle(t, panel)}</h2>
          {panel.kind === 'publish' ? <p className="sub">{t('doc.templates.publish.hint')}</p> : null}
          {panel.kind === 'legal' ? (
            <>
              <p className="sub">{t('doc.templates.legal.hint')}</p>
              <div className="field" data-field="reference">
                <label htmlFor="template-legal-reference">{t('doc.templates.legal.reference.label')}</label>
                <input id="template-legal-reference" value={values.reference} aria-invalid={errors.reference !== undefined} onChange={(event) => setField('reference', event.target.value)} />
                {errors.reference === undefined ? null : (
                  <small role="alert" className="field-error">
                    {fieldProblemMessage(t, errors.reference)}
                  </small>
                )}
              </div>
              <div className="field" data-field="evidence">
                <label htmlFor="template-legal-evidence">{t('doc.templates.legal.evidence.label')}</label>
                <input id="template-legal-evidence" value={values.evidenceDocumentId} aria-invalid={errors.evidenceDocumentId !== undefined} onChange={(event) => setField('evidenceDocumentId', event.target.value)} />
                <small className="sub">{t('doc.templates.legal.evidence.hint')}</small>
                {errors.evidenceDocumentId === undefined ? null : (
                  <small role="alert" className="field-error">
                    {fieldProblemMessage(t, errors.evidenceDocumentId)}
                  </small>
                )}
              </div>
              <div className="field" data-field="note">
                <label htmlFor="template-legal-note">{t('doc.templates.legal.note.label')}</label>
                <textarea id="template-legal-note" value={values.note} aria-invalid={errors.note !== undefined} onChange={(event) => setField('note', event.target.value)} />
                {errors.note === undefined ? null : (
                  <small role="alert" className="field-error">
                    {fieldProblemMessage(t, errors.note)}
                  </small>
                )}
              </div>
            </>
          ) : null}
          {panel.kind === 'retire' ? (
            <>
              <p className="sub">{t('doc.templates.retire.hint')}</p>
              <div className="field">
                <label htmlFor="template-retire-reason">{t('doc.templates.retire.reason.label')}</label>
                <textarea id="template-retire-reason" value={reason} aria-invalid={reasonRefused} onChange={(event) => setReason(event.target.value)} />
                {reasonRefused && reasonProblem(reason) !== undefined ? (
                  <small role="alert" className="field-error">
                    {fieldProblemMessage(t, reasonProblem(reason) ?? 'required')}
                  </small>
                ) : null}
              </div>
            </>
          ) : null}
          {problem === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, problem)}
            </p>
          )}
          <div className="row gap">
            <button type="submit" className="primary" disabled={pending}>
              {panelConfirm(t, panel.kind)}
            </button>
            <button type="button" onClick={() => setPanel(undefined)}>
              {panelCancel(t, panel.kind)}
            </button>
          </div>
        </form>
      )}
      <p className="prototype-note">{t('doc.templates.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

type T = Translator['t'];

function panelTitle(t: T, panel: Panel): string {
  const values = { code: panel.template.templateCode, revision: panel.template.revision };
  return panel.kind === 'publish' ? t('doc.templates.publish.title', values) : panel.kind === 'legal' ? t('doc.templates.legal.title', values) : t('doc.templates.retire.title', values);
}

function panelConfirm(t: T, kind: PanelKind): string {
  return kind === 'publish' ? t('doc.templates.publish.confirm.action') : kind === 'legal' ? t('doc.templates.legal.confirm.action') : t('doc.templates.retire.confirm.action');
}

function panelCancel(t: T, kind: PanelKind): string {
  return kind === 'publish' ? t('doc.templates.publish.cancel.action') : kind === 'legal' ? t('doc.templates.legal.cancel.action') : t('doc.templates.retire.cancel.action');
}
