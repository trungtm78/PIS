import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import './delivery/delivery.css';
import { ReasonPanel } from './delivery/ReasonPanel';
import { useCreateTemplate, useDecideTemplate, useSubmitTemplate, useTemplates } from './template/hooks';
import { channelLabel, classificationLabel, formProblemMessage, problemMessage, statusLabel, statusPill, typeLabel } from './template/labels';
import {
  APPROVE_PERMISSION,
  CHANNELS,
  CLASSIFICATIONS,
  LOCALES,
  MANAGE_PERMISSION,
  PURPOSES,
  READ_PERMISSION,
  VARIABLE_TYPES,
  bodyOf,
  canDecide,
  canSubmit,
  describeProblem,
  emptyForm,
  isLocked,
  isPushChannel,
  problemsOf,
  reviseForm,
  variableSchemaOf,
} from './template/model';
import type { Channel, FormProblem, TemplateForm, TemplateView } from './template/model';
import { purposeLabel } from './workflow/labels';

type Acting = { what: 'submit' } | { what: 'decide'; decision: 'approve' | 'return' | 'reject' };

/**
 * NOT-07: the templates of the messages. A revision of a code × channel × locale is written as a Draft (the words, the variables with their type and classification, the purpose), sent to review and approved by another
 * person; the one that was Active is retired. A revision that has left Draft is locked: it is read, not edited, and a change is a new revision. The phone and provider channels carry only public or internal text without money,
 * and the screen says so before sending (the server judges again).
 */
export default function TemplateEditorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the revision under review and the notices belong to one membership: switching tenant starts the screen over, so nothing written for one is saved into another.
  return <TemplateEditorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TemplateEditorContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const writable = mode !== 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && writable;
  const canApprove = (permissions === undefined || permissions.includes(APPROVE_PERMISSION)) && writable;
  const pages = useTemplates(canRead);
  const create = useCreateTemplate();
  const submit = useSubmitTemplate();
  const decide = useDecideTemplate();
  const items = (pages.data?.pages ?? []).flatMap((page) => page.items);
  const queryState = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data });
  const state = canRead ? queryState : 'denied';
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [shown, setShown] = useState<readonly FormProblem[]>([]);
  const [saved, setSaved] = useState(false);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [acting, setActing] = useState<{ template: TemplateView; action: Acting } | undefined>(undefined);
  const [done, setDone] = useState<'submitted' | 'approved' | 'returned' | 'rejected' | undefined>(undefined);
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const actionProblem = submit.isError ? describeProblem(submit.error) : decide.isError ? describeProblem(decide.error) : undefined;
  const busy = create.isPending || submit.isPending || decide.isPending;
  const day = (value: string): string => instantText(locale, value);
  const open = items.find((template) => template.id === opened);
  const update = (change: Partial<TemplateForm>): void => setForm((current) => ({ ...current, ...change }));

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !canManage) return;
    const found = problemsOf(form);
    setShown(found);
    if (found.length > 0) return;
    setSaved(false);
    create.reset();
    create.mutate(
      {
        body: {
          code: form.code.trim(),
          channel: form.channel,
          locale: form.locale,
          purpose: form.purpose,
          content_ast: bodyOf(form),
          variable_schema: variableSchemaOf(form),
          ...(isPushChannel(form.channel) ? { lockscreen_safe: true } : {}),
          ...(form.supersedesId === undefined ? {} : { supersedes_id: form.supersedesId }),
        },
      },
      {
        onSuccess: () => {
          setSaved(true);
          setForm(emptyForm());
        },
      },
    );
  };

  const startAction = (template: TemplateView, action: Acting): void => {
    submit.reset();
    decide.reset();
    setDone(undefined);
    setActing({ template, action });
  };

  const confirm = (reason: string): void => {
    if (acting === undefined || busy) return;
    const input = { templateId: acting.template.id, version: acting.template.version, reason };
    const finished = (what: NonNullable<typeof done>) => ({
      onSuccess: () => {
        setDone(what);
        setActing(undefined);
      },
    });
    if (acting.action.what === 'submit') submit.mutate(input, finished('submitted'));
    else {
      const decision = acting.action.decision;
      decide.mutate({ ...input, decision }, finished(decision === 'approve' ? 'approved' : decision === 'return' ? 'returned' : 'rejected'));
    }
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.template.page.title')}</h1>
          <p>{t('not.template.page.subtitle')}</p>
        </div>
      </div>
      {canManage ? (
        <form onSubmit={save} noValidate aria-label={t('not.template.form.aria')} className="card billing-issue">
          <h2>{form.supersedesId === undefined ? t('not.template.form.title') : t('not.template.form.revise')}</h2>
          <div className="field">
            <label htmlFor="template-code">{t('not.template.form.code.label')}</label>
            <input id="template-code" type="text" value={form.code} readOnly={form.supersedesId !== undefined} onChange={(event) => update({ code: event.target.value })} />
          </div>
          <div className="row gap">
            <div className="field">
              <label htmlFor="template-channel">{t('not.template.form.channel.label')}</label>
              <select id="template-channel" value={form.channel} disabled={form.supersedesId !== undefined} onChange={(event) => update({ channel: event.target.value as Channel })}>
                {CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {channelLabel(t, channel)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="template-locale">{t('not.template.form.locale.label')}</label>
              <select id="template-locale" value={form.locale} disabled={form.supersedesId !== undefined} onChange={(event) => update({ locale: event.target.value })}>
                {LOCALES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="template-purpose">{t('not.template.form.purpose.label')}</label>
              <select id="template-purpose" value={form.purpose} onChange={(event) => update({ purpose: event.target.value })}>
                {PURPOSES.map((purpose) => (
                  <option key={purpose} value={purpose}>
                    {purposeLabel(t, purpose)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {form.channel === 'EMAIL' ? (
            <div className="field">
              <label htmlFor="template-subject">{t('not.template.form.subject.label')}</label>
              <input id="template-subject" type="text" value={form.subject} onChange={(event) => update({ subject: event.target.value })} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="template-body">{t('not.template.form.body.label')}</label>
            <textarea id="template-body" rows={4} value={form.body} onChange={(event) => update({ body: event.target.value })} />
            <small className="sub">{t('not.template.form.body.hint')}</small>
          </div>
          {isPushChannel(form.channel) ? <p className="callout" data-lockscreen>{t('not.template.form.lockscreen.note')}</p> : null}
          {['SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_ZNS', 'ZALO_OA', 'WHATSAPP'].includes(form.channel) ? <p className="callout warning">{t('not.template.form.restricted.note')}</p> : null}
          <fieldset className="field" data-variables>
            <legend>{t('not.template.form.variables.legend')}</legend>
            {form.variables.map((variable, index) => (
              <div key={index} className="row gap">
                <input
                  type="text"
                  aria-label={t('not.template.form.variable.name', { n: index + 1 })}
                  value={variable.name}
                  onChange={(event) => update({ variables: form.variables.map((candidate, at) => (at === index ? { ...candidate, name: event.target.value } : candidate)) })}
                />
                <select
                  aria-label={t('not.template.form.variable.type', { n: index + 1 })}
                  value={variable.type}
                  onChange={(event) => update({ variables: form.variables.map((candidate, at) => (at === index ? { ...candidate, type: event.target.value } : candidate)) })}
                >
                  {VARIABLE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {typeLabel(t, type)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('not.template.form.variable.classification', { n: index + 1 })}
                  value={variable.classification}
                  onChange={(event) => update({ variables: form.variables.map((candidate, at) => (at === index ? { ...candidate, classification: event.target.value } : candidate)) })}
                >
                  {CLASSIFICATIONS.map((classification) => (
                    <option key={classification} value={classification}>
                      {classificationLabel(t, classification)}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => update({ variables: form.variables.filter((_candidate, at) => at !== index) })}>
                  {t('not.template.form.variable.remove', { n: index + 1 })}
                </button>
              </div>
            ))}
            <button type="button" onClick={() => update({ variables: [...form.variables, { name: '', type: 'string', classification: 'PUBLIC' }] })}>
              {t('not.template.form.variable.add')}
            </button>
          </fieldset>
          {shown.length === 0 ? null : (
            <ul role="alert" className="callout warning" data-form-problems>
              {shown.map((entry, index) => (
                <li key={index}>{formProblemMessage(t, entry)}</li>
              ))}
            </ul>
          )}
          {problem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, problem)}</p>
            </div>
          )}
          {saved ? (
            <p className="callout" role="status">
              {t('not.template.done.saved')}
            </p>
          ) : null}
          <div className="row gap">
            <button type="submit" className="primary" disabled={busy}>
              {t('not.template.form.submit.action')}
            </button>
            {form.supersedesId === undefined ? null : (
              <button type="button" onClick={() => setForm(emptyForm())}>
                {t('not.template.form.revise.cancel')}
              </button>
            )}
          </div>
        </form>
      ) : null}
      {done === undefined ? null : (
        <p className="callout" role="status">
          {done === 'submitted' ? t('not.template.done.submitted') : done === 'approved' ? t('not.template.done.approved') : done === 'returned' ? t('not.template.done.returned') : t('not.template.done.rejected')}
        </p>
      )}
      <div className="card">
        <h2>{t('not.template.list.title')}</h2>
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('not.template.list.none')}
            </p>
          ) : (
            <div className="tablewrap">
              <table data-templates>
                <thead>
                  <tr>
                    <th>{t('not.template.col.code')}</th>
                    <th>{t('not.template.col.channel')}</th>
                    <th>{t('not.template.col.locale')}</th>
                    <th>{t('not.template.col.revision')}</th>
                    <th>{t('not.template.col.status')}</th>
                    <th>{t('not.template.col.created')}</th>
                    <th>
                      <span className="sr-only">{t('not.template.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((template) => (
                    <tr key={template.id} data-template-id={template.id} data-status={template.status}>
                      <td>
                        <code>{template.code}</code>
                      </td>
                      <td>{channelLabel(t, template.channel)}</td>
                      <td>{template.locale}</td>
                      <td>{template.revision}</td>
                      <td>
                        <span className={statusPill(template.status)}>{statusLabel(t, template.status)}</span>
                      </td>
                      <td>{day(template.createdAt)}</td>
                      <td>
                        <div className="row gap">
                          <button type="button" aria-expanded={opened === template.id} onClick={() => setOpened(opened === template.id ? undefined : template.id)}>
                            {t('not.template.open.action')}
                          </button>
                          <Link to={`/not/not-08?template=${template.id}`}>{t('not.template.preview.action')}</Link>
                          {canManage ? (
                            <button type="button" onClick={() => setForm(reviseForm(template))}>
                              {t('not.template.revise.action')}
                            </button>
                          ) : null}
                          {canManage && canSubmit(template) ? (
                            <button type="button" disabled={busy} onClick={() => startAction(template, { what: 'submit' })}>
                              {t('not.template.submit.action')}
                            </button>
                          ) : null}
                          {canApprove && canDecide(template) ? (
                            <>
                              <button type="button" disabled={busy} onClick={() => startAction(template, { what: 'decide', decision: 'approve' })}>
                                {t('not.template.approve.action')}
                              </button>
                              <button type="button" disabled={busy} onClick={() => startAction(template, { what: 'decide', decision: 'return' })}>
                                {t('not.template.return.action')}
                              </button>
                              <button type="button" disabled={busy} onClick={() => startAction(template, { what: 'decide', decision: 'reject' })}>
                                {t('not.template.reject.action')}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {t('not.template.list.more.action')}
              </button>
            </div>
          ) : null}
        </StateBoundary>
        {acting === undefined ? null : (
          <ReasonPanel
            testId="template-reason"
            title={acting.action.what === 'submit' ? t('not.template.submit.title') : acting.action.decision === 'approve' ? t('not.template.approve.title') : acting.action.decision === 'return' ? t('not.template.return.title') : t('not.template.reject.title')}
            hint={t('not.template.reason.hint', { code: acting.template.code, revision: acting.template.revision })}
            reasonLabel={t('not.template.reason.label')}
            reasonError={t('not.template.reason.tooShort')}
            confirmLabel={t('not.template.reason.confirm.action')}
            dismissLabel={t('not.template.reason.abort.action')}
            pending={busy}
            problem={actionProblem === undefined ? undefined : problemMessage(t, actionProblem)}
            onConfirm={confirm}
            onDismiss={() => setActing(undefined)}
          />
        )}
        {open === undefined ? null : (
          <div data-template-detail data-locked={isLocked(open)}>
            <h3>{t('not.template.detail.title', { code: open.code, revision: open.revision })}</h3>
            {isLocked(open) ? (
              <p className="callout" role="status" data-locked-note>
                {t('not.template.detail.locked')}
              </p>
            ) : null}
            <dl className="kv">
              <dt>{t('not.template.detail.purpose')}</dt>
              <dd>{purposeLabel(t, open.purpose)}</dd>
              {open.subject === undefined ? null : (
                <>
                  <dt>{t('not.template.form.subject.label')}</dt>
                  <dd>{open.subject}</dd>
                </>
              )}
              <dt>{t('not.template.form.body.label')}</dt>
              <dd>
                <pre data-detail-body>{open.body}</pre>
              </dd>
              <dt>{t('not.template.form.variables.legend')}</dt>
              <dd data-detail-variables>
                {open.variables.length === 0
                  ? '—'
                  : open.variables.map((variable) => `${variable.name} (${typeLabel(t, variable.type)}, ${classificationLabel(t, variable.classification)})`).join('; ')}
              </dd>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
