import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import './delivery/delivery.css';
import { useSetTestRecipients, useTemplate, useTemplates, useTestRecipients, useTestSend } from './template/hooks';
import { channelLabel, classificationLabel, problemMessage, typeLabel } from './template/labels';
import { MANAGE_PERMISSION, MAX_RECIPIENTS, READ_PERMISSION, describeProblem, isLocked, isUuid, previewOf, samplesOf } from './template/model';
import type { TemplateView } from './template/model';

/**
 * NOT-08: the preview and the test send of a template revision. The author fills sample values for the variables and sees the message as it will be written, with the prefix every test message has; a test goes only to the
 * people the tenant listed (at most ten), is not a notification and is not counted in the metrics of the center. A phone or provider template carries no money and nothing confidential, so the sample of such a variable never
 * reaches a phone.
 */
/** The channels whose templates are tested through the provider, which is not wired yet (ST-NOT-005, R3). */
const PROVIDER_ONLY: ReadonlySet<string> = new Set(['ZALO_ZNS', 'ZALO_OA', 'WHATSAPP']);

export default function TemplatePreviewScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION) || permissions.includes(MANAGE_PERMISSION);
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const templateId = params.get('template') ?? undefined;
  const one = useTemplate(templateId, canRead);
  const list = useTemplates(canRead && templateId === undefined);
  const choices = (list.data?.pages ?? []).flatMap((page) => page.items);
  const queryState = useScreenState({ isLoading: templateId === undefined ? list.isLoading : one.isLoading, error: templateId === undefined ? list.error : one.error, data: templateId === undefined ? list.data : (one.data ?? null) });
  const state = canRead ? queryState : 'denied';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.preview.page.title')}</h1>
          <p>{t('not.preview.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void (templateId === undefined ? list.refetch() : one.refetch())}>
        {templateId === undefined ? (
          <div className="card">
            <label htmlFor="preview-template">{t('not.preview.pick.label')}</label>
            <select id="preview-template" value="" onChange={(event) => setParams({ template: event.target.value })}>
              <option value="">{t('not.preview.pick.none')}</option>
              {choices.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.code} · {channelLabel(t, template.channel)} · {template.locale} · {template.revision}
                </option>
              ))}
            </select>
            {list.hasNextPage ? (
              <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('not.preview.pick.more.action')}
              </button>
            ) : null}
          </div>
        ) : one.data === undefined ? null : (
          // The samples and the choices belong to one revision: another starts them over.
          <Preview key={one.data.id} template={one.data} canManage={canManage} />
        )}
      </StateBoundary>
    </section>
  );
}

function Preview({ template, canManage }: { template: TemplateView; canManage: boolean }) {
  const { t } = useTranslation();
  const recipients = useTestRecipients(canManage);
  const setRecipients = useSetTestRecipients();
  const send = useTestSend();
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState('');
  const [newIdInvalid, setNewIdInvalid] = useState(false);
  const [sent, setSent] = useState(false);
  const [listSaved, setListSaved] = useState(false);
  const preview = useMemo(() => previewOf(template, entered), [template, entered]);
  const listed = recipients.data ?? [];
  const problem = send.isError ? describeProblem(send.error) : setRecipients.isError ? describeProblem(setRecipients.error) : undefined;
  // The list is replaced as a whole, so nothing is changed before it has been read: a list that is loading or failed is not an empty one.
  const listReady = recipients.isSuccess;
  const busy = send.isPending || setRecipients.isPending || !listReady;
  // What the server tests: a template of a provider (ZNS, WhatsApp, Zalo OA) is tested through the provider, later.
  const sendable = (template.status === 'Draft' || template.status === 'InReview' || template.status === 'Active') && !PROVIDER_ONLY.has(template.channel);

  const addRecipient = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const id = newId.trim().toLowerCase();
    if (!isUuid(id) || listed.includes(id) || listed.length >= MAX_RECIPIENTS) {
      setNewIdInvalid(true);
      return;
    }
    setNewIdInvalid(false);
    setListSaved(false);
    setRecipients.reset();
    setRecipients.mutate({ membershipIds: [...listed, id] }, { onSuccess: () => { setNewId(''); setListSaved(true); } });
  };

  const removeRecipient = (id: string): void => {
    if (busy) return;
    setListSaved(false);
    setRecipients.reset();
    setChosen((current) => new Set([...current].filter((candidate) => candidate !== id)));
    setRecipients.mutate({ membershipIds: listed.filter((candidate) => candidate !== id) }, { onSuccess: () => setListSaved(true) });
  };

  const sendTest = (): void => {
    if (busy || chosen.size === 0) return;
    setSent(false);
    send.reset();
    send.mutate({ templateId: template.id, recipientIds: [...chosen], samples: samplesOf(template.variables, entered) }, { onSuccess: () => setSent(true) });
  };

  return (
    <>
      <div className="card" data-template-facts>
        <h2>
          {template.code} · {channelLabel(t, template.channel)} · {template.locale} · {t('not.preview.revision', { revision: template.revision })}
        </h2>
        {isLocked(template) ? (
          <p className="callout" role="status" data-locked-note>
            {t('not.template.detail.locked')}
          </p>
        ) : null}
        <h3>{t('not.preview.samples.title')}</h3>
        {template.variables.length === 0 ? <p className="sub">{t('not.preview.samples.none')}</p> : null}
        {template.variables.map((variable) => (
          <div className="field" key={variable.name}>
            <label htmlFor={`sample-${variable.name}`}>
              {variable.name} ({typeLabel(t, variable.type)}, {classificationLabel(t, variable.classification)})
            </label>
            {variable.type === 'boolean' ? (
              <select id={`sample-${variable.name}`} value={entered[variable.name] ?? ''} onChange={(event) => setEntered({ ...entered, [variable.name]: event.target.value })}>
                <option value="">—</option>
                <option value="true">{t('not.preview.boolean.true')}</option>
                <option value="false">{t('not.preview.boolean.false')}</option>
              </select>
            ) : (
              <input id={`sample-${variable.name}`} type="text" value={entered[variable.name] ?? ''} onChange={(event) => setEntered({ ...entered, [variable.name]: event.target.value })} />
            )}
          </div>
        ))}
        <h3>{t('not.preview.message.title')}</h3>
        <div className="callout" data-preview>
          {preview.subject === undefined ? null : <p data-preview-subject>{preview.subject}</p>}
          <p data-preview-text>{preview.text}</p>
        </div>
        {preview.missing.length === 0 ? null : (
          <p className="callout warning" role="status" data-missing>
            {t('not.preview.missing', { names: preview.missing.join(', ') })}
          </p>
        )}
      </div>
      {canManage ? (
        <div className="card" data-test-send>
          <h2>{t('not.preview.send.title')}</h2>
          <p className="sub">{t('not.preview.send.rule', { max: MAX_RECIPIENTS })}</p>
          {recipients.isError ? (
            <div className="callout warning" role="alert" data-recipients-error>
              <p>{t('not.preview.recipients.error')}</p>
              <button type="button" onClick={() => void recipients.refetch()}>
                {t('not.preview.recipients.retry.action')}
              </button>
            </div>
          ) : recipients.isLoading ? (
            <p className="sub" role="status">
              {t('not.preview.recipients.loading')}
            </p>
          ) : listed.length === 0 ? (
            <p className="sub" role="status">
              {t('not.preview.recipients.none')}
            </p>
          ) : (
            <ul data-recipients>
              {listed.map((id) => (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(id)}
                      onChange={(event) => setChosen((current) => new Set(event.target.checked ? [...current, id] : [...current].filter((candidate) => candidate !== id)))}
                    />{' '}
                    <code>{id}</code>
                  </label>{' '}
                  <button type="button" disabled={busy} onClick={() => removeRecipient(id)}>
                    {t('not.preview.recipients.remove.action', { id: id.slice(0, 8) })}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addRecipient} noValidate aria-label={t('not.preview.recipients.aria')} className="row gap">
            <label htmlFor="preview-recipient">{t('not.preview.recipients.add.label')}</label>
            <input id="preview-recipient" type="text" value={newId} aria-invalid={newIdInvalid} onChange={(event) => setNewId(event.target.value)} />
            <button type="submit" disabled={busy}>
              {t('not.preview.recipients.add.action')}
            </button>
          </form>
          {newIdInvalid ? (
            <small role="alert" className="field-error">
              {t('not.preview.recipients.add.invalid', { max: MAX_RECIPIENTS })}
            </small>
          ) : null}
          {listSaved ? (
            <p className="callout" role="status">
              {t('not.preview.recipients.saved')}
            </p>
          ) : null}
          {problem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, problem)}</p>
            </div>
          )}
          {sent ? (
            <p className="callout" role="status">
              {t('not.preview.send.done')}
            </p>
          ) : null}
          <div className="row gap">
            <button type="button" className="primary" disabled={busy || chosen.size === 0 || !sendable} onClick={sendTest}>
              {t('not.preview.send.action')}
            </button>
            {sendable ? null : <span className="sub">{t('not.preview.send.notSendable')}</span>}
          </div>
        </div>
      ) : null}
    </>
  );
}
