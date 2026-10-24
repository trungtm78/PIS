import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import {
  useCancelDocument,
  useCreateDraft,
  useDraft,
  usePreview,
  useSubmitDraft,
  useTemplateBody,
  useUpdateDraft,
} from './drafts/hooks';
import { circulationLabel, failureMessage, fieldProblemMessage, problemMessage, recipientKindLabel, signingModeLabel, statusLabel, urgencyLabel, cancelCodeLabel } from './drafts/labels';
import { describeProblem } from './drafts/problems';
import type { DraftProblem } from './drafts/problems';
import {
  EMPTY_FORM,
  FIXED_FIELDS,
  createBody,
  formOf,
  formProblems,
  newRecipient,
  payloadFields,
  payloadOf,
  reasonProblem,
  updateBody,
  vietnamDate,
} from './drafts/rules';
import type { DraftForm, FieldProblem } from './drafts/rules';
import {
  CANCEL_CODES,
  CANCEL_DOCUMENT_PERMISSION,
  CIRCULATIONS,
  CREATE_DOCUMENT_PERMISSION,
  EDIT_DOCUMENT_PERMISSION,
  RECIPIENT_KINDS,
  RENDER_PERMISSION,
  SIGNING_MODES,
  SUBMIT_DOCUMENT_PERMISSION,
  URGENCIES,
} from './drafts/types';
import type { CancelCode, Circulation, RecipientKind, SigningMode, Urgency } from './drafts/types';
import { useTemplates } from './templates/hooks';
import { useUnitOptions } from './registers/hooks';
import './drafts/drafts.css';

const REVIEW_PATH = '/doc/doc-04';
const LIST_PATH = '/doc/doc-03';

/** DOC-02: the drafter composes an outgoing document from a template, previews it and sends it for review. */
export default function OutgoingEditorScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  const [params] = useSearchParams();
  // The form belongs to one tenant and one document: a switch or another document starts the screen over.
  return <EditorContent key={`${tenantId ?? 'none'}:${params.get('doc') ?? 'new'}`} route={route} />;
}

function EditorContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const { permissions, mode } = useSession();
  const documentId = params.get('doc') ?? undefined;
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;
  const today = vietnamDate(new Date());
  const detail = useDraft(documentId);
  const templates = useTemplates({ group: '', status: 'PUBLISHED', asOf: today });
  const units = useUnitOptions();
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [savedId, setSavedId] = useState<string | undefined>(documentId);
  const [dirty, setDirty] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'submitted' | 'cancelled' | undefined>((location.state as { saved?: boolean } | null)?.saved === true ? 'saved' : undefined);
  const [problem, setProblem] = useState<DraftProblem | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelCode, setCancelCode] = useState<CancelCode>('CANCELLED_BY_DRAFTER');
  const [cancelRefused, setCancelRefused] = useState(false);
  const create = useCreateDraft();
  const update = useUpdateDraft();
  const submit = useSubmitDraft();
  const cancel = useCancelDocument();
  const preview = usePreview();

  const available = useMemo(() => templates.data?.pages.flatMap((page) => page.items) ?? [], [templates.data]);
  const docTypes = useMemo(() => [...new Set([...available.map((template) => template.docTypeCode), form.docTypeCode].filter((code) => code !== ''))].sort(), [available, form.docTypeCode]);
  const templatesOfType = useMemo(() => available.filter((template) => template.docTypeCode === form.docTypeCode), [available, form.docTypeCode]);
  const existing = detail.data;
  // A saved draft keeps the template it was made from; a new one takes the template that was picked.
  const chosen = existing === undefined ? templatesOfType.find((template) => template.templateCode === form.templateCode) : available.find((template) => template.id === existing.templateId);
  const body = useTemplateBody(chosen?.id);
  const fields = useMemo(() => payloadFields(body.data?.blocks ?? [], body.data?.required ?? []), [body.data]);

  // An existing draft is read once into the form; later changes are the user's until a save or a reload.
  useEffect(() => {
    if (detail.data === undefined || loadedFor === detail.data.id) return;
    const template = available.find((candidate) => candidate.id === detail.data.templateId);
    setForm(formOf(detail.data, template?.templateCode ?? ''));
    setVersion(detail.data.version);
    setSavedId(detail.data.id);
    setLoadedFor(detail.data.id);
    setDirty(false);
  }, [detail.data, loadedFor, available]);

  const status = existing?.status ?? 'DRAFT';
  const canEdit = existing === undefined ? holds(CREATE_DOCUMENT_PERMISSION) : holds(EDIT_DOCUMENT_PERMISSION) && status === 'DRAFT';
  const canSubmit = holds(SUBMIT_DOCUMENT_PERMISSION) && savedId !== undefined && status === 'DRAFT';
  const canCancel = holds(CANCEL_DOCUMENT_PERMISSION) && savedId !== undefined && ['DRAFT', 'IN_REVIEW', 'SUBMITTED', 'SIGNED'].includes(status);
  const problems = useMemo(() => formProblems(form, { creating: savedId === undefined }), [form, savedId]);
  const problemOf = (field: string): FieldProblem | undefined => (showProblems ? problems.find((candidate) => candidate.field === field) : undefined);
  const busy = create.isPending || update.isPending || submit.isPending || cancel.isPending;
  const state = useScreenState({ isLoading: documentId !== undefined && detail.isLoading, error: documentId === undefined ? undefined : detail.error, data: documentId === undefined ? {} : detail.data });

  const change = (patch: Partial<DraftForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
    setNotice(undefined);
  };
  const changeValue = (name: string, value: string): void => change({ values: { ...form.values, [name]: value } });
  const chooseType = (docTypeCode: string): void => {
    const candidates = available.filter((template) => template.docTypeCode === docTypeCode);
    const preferred = candidates.find((template) => template.templateCode === `${docTypeCode}-DEFAULT`) ?? candidates[0];
    change({ docTypeCode, templateCode: preferred?.templateCode ?? '' });
  };

  const fail = (error: unknown): void => setProblem(describeProblem(error));

  const save = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!canEdit || busy) return;
    setShowProblems(true);
    setProblem(undefined);
    if (problems.length > 0) return;
    if (savedId === undefined) {
      create.mutate(createBody(form), {
        onSuccess: (result) => {
          setSavedId(result.id);
          setVersion(result.version);
          setDirty(false);
          setNotice('saved');
          navigate(`?doc=${result.id}`, { replace: true, state: { saved: true } });
        },
        onError: fail,
      });
      return;
    }
    update.mutate(
      { documentId: savedId, version, body: updateBody(form) },
      {
        onSuccess: (result) => {
          setVersion(result.version);
          setDirty(false);
          setNotice('saved');
        },
        onError: fail,
      },
    );
  };

  const send = (): void => {
    if (!canSubmit || busy || dirty || savedId === undefined) return;
    setProblem(undefined);
    submit.mutate(
      { documentId: savedId, version },
      {
        onSuccess: (result) => {
          setVersion(result.version);
          setNotice('submitted');
          navigate(`${REVIEW_PATH}?doc=${savedId}`);
        },
        onError: fail,
      },
    );
  };

  const confirmCancel = (event: FormEvent): void => {
    event.preventDefault();
    if (!canCancel || busy || savedId === undefined) return;
    if (reasonProblem(cancelReason) !== undefined) {
      setCancelRefused(true);
      return;
    }
    setProblem(undefined);
    cancel.mutate(
      { documentId: savedId, version, reason: cancelReason, rejectCode: cancelCode },
      {
        onSuccess: () => {
          setCancelling(false);
          setNotice('cancelled');
          void detail.refetch();
        },
        onError: fail,
      },
    );
  };

  const showPreview = (): void => {
    if (chosen === undefined) return;
    const payload = { ...payloadOf(form.values) };
    if (payload.summary === undefined && form.title.trim() !== '') payload.summary = form.title.trim();
    const names = form.recipients.map((recipient) => recipient.name.trim()).filter((name) => name !== '');
    if (names.length > 0) payload.recipients = names;
    preview.mutate({ templateCode: chosen.templateCode, asOfDate: today, payload });
  };

  const reload = (): void => {
    setProblem(undefined);
    setLoadedFor(undefined);
    void detail.refetch();
  };

  const failed = problem !== undefined;
  const fieldMark = (name: string): { 'aria-invalid': boolean } => ({ 'aria-invalid': problemOf(name) !== undefined || (problem?.failures.some((failure) => failure.field === name) ?? false) });
  const fieldError = (name: string) => {
    const found = problemOf(name);
    return found === undefined ? null : (
      <small role="alert" className="field-error">
        {fieldProblemMessage(t, found)}
      </small>
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="doc-drafts">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.editor.page.title')}</h1>
          <p>{t('doc.editor.page.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="button" to={LIST_PATH}>
            {t('doc.editor.back.action')}
          </Link>
        </div>
      </div>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('doc.editor.frozen.notice')}
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void detail.refetch()}>
        {existing !== undefined && existing.status !== 'DRAFT' ? (
          <p className="callout" role="status">
            {t('doc.editor.locked.notice', { status: statusLabel(t, existing.status) })}{' '}
            {existing.status === 'IN_REVIEW' ? <Link to={`${REVIEW_PATH}?doc=${existing.id}`}>{t('doc.editor.locked.review')}</Link> : null}
          </p>
        ) : null}
        {existing?.status === 'DRAFT' && existing.latestReview?.kind === 'RETURNED' ? (
          <div className="callout warning" role="status" data-returned="true">
            <strong>{t('doc.editor.returned.title')}</strong>
            <p>{existing.latestReview.comment}</p>
          </div>
        ) : null}
        {existing?.status === 'CANCELLED' && existing.cancelReason !== null ? (
          <div className="callout" role="status">
            <strong>{t('doc.editor.cancelled.title')}</strong>
            <p>{existing.cancelReason}</p>
          </div>
        ) : null}
        {notice === undefined ? null : (
          <p className="callout" role="status">
            {notice === 'saved' ? t('doc.editor.saved.notice') : notice === 'submitted' ? t('doc.editor.submitted.notice') : t('doc.editor.cancelled.notice')}
          </p>
        )}
        <form className="card editor-form" onSubmit={save} noValidate aria-label={t('doc.editor.form.label')}>
          <fieldset disabled={!canEdit || busy}>
            <h2>{t('doc.editor.section.type')}</h2>
            <div className="formgrid">
              <div className="field">
                <label htmlFor="editor-type">{t('doc.editor.type.label')}</label>
                <select id="editor-type" value={form.docTypeCode} disabled={savedId !== undefined} {...fieldMark('docTypeCode')} onChange={(event) => chooseType(event.target.value)}>
                  <option value="">{t('doc.editor.type.choose')}</option>
                  {docTypes.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
                {fieldError('docTypeCode')}
              </div>
              <div className="field">
                <label htmlFor="editor-template">{t('doc.editor.template.label')}</label>
                <select id="editor-template" value={form.templateCode} disabled={savedId !== undefined} onChange={(event) => change({ templateCode: event.target.value })}>
                  <option value="">{t('doc.editor.template.default')}</option>
                  {templatesOfType.map((template) => (
                    <option key={template.id} value={template.templateCode}>
                      {template.templateCode} · {template.title}
                    </option>
                  ))}
                </select>
                {chosen?.rendersWatermarked === true ? <small className="muted">{t('doc.editor.template.watermark')}</small> : null}
              </div>
              <div className="field">
                <label htmlFor="editor-unit">{t('doc.editor.unit.label')}</label>
                <select id="editor-unit" value={form.unitId} disabled={savedId !== undefined} {...fieldMark('unitId')} onChange={(event) => change({ unitId: event.target.value })}>
                  <option value="">{t('doc.editor.unit.choose')}</option>
                  {(units.data ?? []).map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.code} · {unit.name}
                    </option>
                  ))}
                </select>
                {fieldError('unitId')}
              </div>
            </div>
            <h2>{t('doc.editor.section.general')}</h2>
            <div className="formgrid">
              <div className="field wide">
                <label htmlFor="editor-title">{t('doc.editor.title.label')}</label>
                <input id="editor-title" value={form.title} maxLength={500} {...fieldMark('title')} onChange={(event) => change({ title: event.target.value })} />
                {fieldError('title')}
              </div>
              <div className="field">
                <label htmlFor="editor-urgency">{t('doc.editor.urgency.label')}</label>
                <select id="editor-urgency" value={form.urgency} onChange={(event) => change({ urgency: event.target.value as Urgency })}>
                  {URGENCIES.map((urgency) => (
                    <option key={urgency} value={urgency}>
                      {urgencyLabel(t, urgency)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="editor-circulation">{t('doc.editor.circulation.label')}</label>
                <select id="editor-circulation" value={form.circulation} disabled={savedId !== undefined} onChange={(event) => change({ circulation: event.target.value as Circulation })}>
                  {CIRCULATIONS.map((circulation) => (
                    <option key={circulation} value={circulation}>
                      {circulationLabel(t, circulation)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <h2>{t('doc.editor.section.content')}</h2>
            <div className="formgrid">
              {FIXED_FIELDS.map((name) => (
                <div className="field" key={name}>
                  <label htmlFor={`editor-field-${name}`}>{fixedLabel(t, name)}</label>
                  <input id={`editor-field-${name}`} value={form.values[name] ?? ''} inputMode={name === 'amount_vnd' ? 'numeric' : undefined} {...fieldMark(name)} onChange={(event) => changeValue(name, event.target.value)} />
                  {fieldError(name)}
                  {name === 'amount_vnd' ? <small className="muted">{t('doc.editor.amount.hint')}</small> : null}
                </div>
              ))}
              {fields.map((field) => (
                <div className="field wide" key={field.name}>
                  <label htmlFor={`editor-field-${field.name}`}>
                    {field.name}
                    {field.required ? <span aria-hidden="true"> *</span> : null}
                  </label>
                  {field.multiline ? (
                    <textarea id={`editor-field-${field.name}`} rows={5} value={form.values[field.name] ?? ''} onChange={(event) => changeValue(field.name, event.target.value)} />
                  ) : (
                    <input id={`editor-field-${field.name}`} value={form.values[field.name] ?? ''} onChange={(event) => changeValue(field.name, event.target.value)} />
                  )}
                </div>
              ))}
            </div>
            <h2>{t('doc.editor.section.recipients')}</h2>
            <ul className="recipients" aria-label={t('doc.editor.section.recipients')}>
              {form.recipients.map((recipient, index) => (
                <li key={recipient.key} className="row gap">
                  <label className="sr-only" htmlFor={`recipient-kind-${recipient.key}`}>
                    {t('doc.editor.recipient.kind')}
                  </label>
                  <select
                    id={`recipient-kind-${recipient.key}`}
                    value={recipient.kind}
                    onChange={(event) => change({ recipients: form.recipients.map((item, position) => (position === index ? { ...item, kind: event.target.value as RecipientKind } : item)) })}
                  >
                    {RECIPIENT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {recipientKindLabel(t, kind)}
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor={`recipient-name-${recipient.key}`}>
                    {t('doc.editor.recipient.name')}
                  </label>
                  <input
                    id={`recipient-name-${recipient.key}`}
                    value={recipient.name}
                    placeholder={t('doc.editor.recipient.name')}
                    onChange={(event) => change({ recipients: form.recipients.map((item, position) => (position === index ? { ...item, name: event.target.value } : item)) })}
                  />
                  <button type="button" aria-label={t('doc.editor.recipient.remove.label', { name: recipient.name })} onClick={() => change({ recipients: form.recipients.filter((_, position) => position !== index) })}>
                    {t('doc.editor.recipient.remove.action')}
                  </button>
                </li>
              ))}
            </ul>
            {fieldError('recipients')}
            <button type="button" onClick={() => change({ recipients: [...form.recipients, newRecipient()] })}>
              {t('doc.editor.recipient.add.action')}
            </button>
            <h2>{t('doc.editor.section.signer')}</h2>
            <div className="formgrid">
              <div className="field">
                <label htmlFor="editor-signer">{t('doc.editor.signer.label')}</label>
                <input id="editor-signer" value={form.signerId} spellCheck={false} {...fieldMark('signerId')} onChange={(event) => change({ signerId: event.target.value })} />
                {fieldError('signerId')}
                <small className="muted">{t('doc.editor.signer.hint')}</small>
              </div>
              <div className="field">
                <label htmlFor="editor-mode">{t('doc.editor.mode.label')}</label>
                <select id="editor-mode" value={form.signingMode} onChange={(event) => change({ signingMode: event.target.value as SigningMode })}>
                  {SIGNING_MODES.map((signingMode) => (
                    <option key={signingMode} value={signingMode}>
                      {signingModeLabel(t, signingMode)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="editor-delegation">{t('doc.editor.delegation.label')}</label>
                <input id="editor-delegation" value={form.delegationId} spellCheck={false} {...fieldMark('delegationId')} onChange={(event) => change({ delegationId: event.target.value })} />
                {fieldError('delegationId')}
              </div>
            </div>
          </fieldset>
          {failed ? (
            <div className="callout warning" role="alert" data-problem={problem.reason}>
              <p>{problemMessage(t, problem)}</p>
              {problem.reason === 'formatCheck' ? (
                <ul>
                  {problem.failures.map((failure) => (
                    <li key={`${failure.field}:${failure.code}`}>{failureMessage(t, failure)}</li>
                  ))}
                </ul>
              ) : null}
              {problem.reason === 'conflict' ? (
                <button type="button" onClick={reload}>
                  {t('doc.editor.reload.action')}
                </button>
              ) : null}
              {problem.reason === 'stateSecret' ? <small>{t('doc.editor.secret.hint')}</small> : null}
            </div>
          ) : null}
          <div className="row gap">
            {canEdit ? (
              <button type="submit" className="primary" disabled={busy}>
                {t('doc.editor.save.action')}
              </button>
            ) : null}
            {holds(RENDER_PERMISSION) ? (
              <button type="button" disabled={chosen === undefined || preview.isPending} title={chosen === undefined ? t('doc.editor.preview.disabled') : undefined} onClick={showPreview}>
                {t('doc.editor.preview.action')}
              </button>
            ) : null}
            {canSubmit ? (
              <button type="button" disabled={busy || dirty} title={dirty ? t('doc.editor.submit.unsaved') : undefined} onClick={send}>
                {t('doc.editor.submit.action')}
              </button>
            ) : null}
            {canCancel ? (
              <button type="button" disabled={busy} onClick={() => setCancelling(true)}>
                {t('doc.editor.cancel.action')}
              </button>
            ) : null}
          </div>
        </form>
        {preview.isError ? (
          <p className="callout warning" role="alert">
            {problemMessage(t, describeProblem(preview.error))}
          </p>
        ) : null}
        {preview.data === undefined ? null : (
          <div className="card" data-preview-of={preview.data.versionId} role="status">
            <h2>{t('doc.editor.preview.title')}</h2>
            {preview.data.watermarked ? <p className="callout warning">{t('doc.editor.preview.watermarked')}</p> : null}
            <p className="sub">{t('doc.editor.preview.facts', { pages: preview.data.pageCount, sha: preview.data.sha256.slice(0, 16) })}</p>
            {preview.data.url === undefined ? (
              <p className="muted">{t('doc.editor.preview.noLink')}</p>
            ) : (
              <a href={preview.data.url} target="_blank" rel="noreferrer">
                {t('doc.editor.preview.open')}
              </a>
            )}
          </div>
        )}
        {cancelling && canCancel ? (
          <form className="card" onSubmit={confirmCancel} noValidate aria-label={t('doc.editor.cancel.title')}>
            <h2>{t('doc.editor.cancel.title')}</h2>
            <p className="sub">{t('doc.editor.cancel.hint')}</p>
            <div className="field">
              <label htmlFor="cancel-code">{t('doc.editor.cancel.code.label')}</label>
              <select id="cancel-code" value={cancelCode} onChange={(event) => setCancelCode(event.target.value as CancelCode)}>
                {CANCEL_CODES.map((code) => (
                  <option key={code} value={code}>
                    {cancelCodeLabel(t, code)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cancel-reason">{t('doc.editor.cancel.reason.label')}</label>
              <textarea id="cancel-reason" value={cancelReason} aria-invalid={cancelRefused} onChange={(event) => setCancelReason(event.target.value)} />
              {cancelRefused && reasonProblem(cancelReason) !== undefined ? (
                <small role="alert" className="field-error">
                  {fieldProblemMessage(t, { field: 'reason', code: reasonProblem(cancelReason) === 'REQUIRED' ? 'REQUIRED' : 'TOO_SHORT' })}
                </small>
              ) : null}
            </div>
            <div className="row gap">
              <button type="submit" className="primary" disabled={busy}>
                {t('doc.editor.cancel.confirm.action')}
              </button>
              <button type="button" onClick={() => setCancelling(false)}>
                {t('doc.editor.cancel.back.action')}
              </button>
            </div>
          </form>
        ) : null}
        {existing !== undefined && existing.payloadSha256 !== null ? (
          <p className="tiny muted" data-payload-hash={existing.payloadSha256}>
            {t('doc.editor.hash.text', { sha: existing.payloadSha256.slice(0, 16) })}
          </p>
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('doc.editor.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function fixedLabel(t: ReturnType<typeof useTranslation>['t'], name: (typeof FIXED_FIELDS)[number]): string {
  switch (name) {
    case 'agency':
      return t('doc.editor.field.agency');
    case 'parent_agency':
      return t('doc.editor.field.parentAgency');
    case 'place':
      return t('doc.editor.field.place');
    case 'signer_title':
      return t('doc.editor.field.signerTitle');
    case 'signer_name':
      return t('doc.editor.field.signerName');
    case 'amount_vnd':
      return t('doc.editor.field.amount');
  }
}
