import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import './delivery/delivery.css';
import { useCreateDraft, useEventTypes, usePublish, useWorkflows } from './workflow/hooks';
import { channelLabel, classificationLabel, priorityLabel, problemMessage, purposeLabel, statusLabel, statusPill } from './workflow/labels';
import {
  MAX_EXPIRY_MINUTES,
  MAX_OVERRIDE_REASON,
  MAX_PUBLISH_REASON,
  MIN_EXPIRY_MINUTES,
  MIN_OVERRIDE_REASON,
  PRIORITIES,
  PUBLISH_PERMISSION,
  canPublish,
  definitionFromForm,
  describeProblem,
  emptyForm,
  inboxIsForced,
  invalidFields,
  isPublishReasonValid,
  moveChannel,
} from './workflow/model';
import type { DesignerForm, EventTypeView, FormField, Priority, WorkflowView } from './workflow/model';

/**
 * NOT-06: the workflow of an event type. A notification administrator chooses an event type of the catalogue, says who is told (the recipients), how (the channels, in the order they are tried: the fallback), how urgent
 * the message is, whether it must be acknowledged, when it expires and, for a CRITICAL message only and with a reason, whether it may be sent in the quiet hours. The draft is published by another administrator; the
 * notifications made afterwards follow the new revision, and the ones made before keep theirs. The server judges the definition again (the screen only saves a round trip).
 */
export default function WorkflowDesignerScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const canRead = permissions === undefined || permissions.includes(PUBLISH_PERMISSION);
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const canWrite = canRead && mode !== 'READ_ONLY';
  const types = useEventTypes(canRead);
  // One entry for each event type: the latest schema version that is still accepted, the one the server judges a workflow against.
  const active = useMemo(() => {
    const latest = new Map<string, EventTypeView>();
    for (const candidate of types.data ?? []) {
      const held = latest.get(candidate.eventType);
      if (candidate.active && (held === undefined || candidate.schemaVersion > held.schemaVersion)) latest.set(candidate.eventType, candidate);
    }
    return [...latest.values()];
  }, [types.data]);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const entry = active.find((candidate) => candidate.eventType === (chosen ?? active[0]?.eventType));
  const queryState = useScreenState({ isLoading: types.isLoading, error: types.error, data: types.data });
  const state = canRead ? queryState : 'denied';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.workflow.page.title')}</h1>
          <p>{t('not.workflow.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void types.refetch()}>
        <div className="card">
          <div className="filters">
            <div>
              <label htmlFor="workflow-event">{t('not.workflow.event.label')}</label>
              <select id="workflow-event" value={entry?.eventType ?? ''} onChange={(event) => setChosen(event.target.value)}>
                {active.map((candidate) => (
                  <option key={candidate.eventType} value={candidate.eventType}>
                    {candidate.eventType}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {entry === undefined ? (
            <p className="sub" role="status">
              {t('not.workflow.event.none')}
            </p>
          ) : (
            <>
              <p className="sub" data-event-facts>
                {t('not.workflow.event.facts', {
                  module: entry.owningModule,
                  purposes: entry.allowedPurposes.map((purpose) => purposeLabel(t, purpose)).join(', '),
                  classification: classificationLabel(t, entry.classification),
                })}
              </p>
              {/* The forms, the draft under review and the attempts belong to one event type of one membership: choosing another event type, or another tenant, starts them over. */}
              <Designer key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${entry.eventType}`} entry={entry} canWrite={canWrite} />
            </>
          )}
        </div>
      </StateBoundary>
    </section>
  );
}

function Designer({ entry, canWrite }: { entry: EventTypeView; canWrite: boolean }) {
  const { t, locale } = useTranslation();
  const workflows = useWorkflows(entry.eventType, true);
  const create = useCreateDraft();
  const publish = usePublish();
  const [form, setForm] = useState<DesignerForm>(() => emptyForm(entry.allowedPurposes[0] ?? 'OPERATIONAL'));
  const [invalid, setInvalid] = useState<ReadonlySet<FormField>>(new Set());
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState<WorkflowView | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonInvalid, setReasonInvalid] = useState(false);
  const [published, setPublished] = useState(false);

  const items = (workflows.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: workflows.isLoading, error: workflows.error, data: workflows.data });
  const problem = create.isError ? describeProblem(create.error) : publish.isError ? describeProblem(publish.error) : undefined;
  const busy = create.isPending || publish.isPending;
  const day = (value: string): string => instantText(locale, value);
  const update = (change: Partial<DesignerForm>): void => setForm((current) => ({ ...current, ...change }));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !canWrite) return;
    const bad = invalidFields(form, entry.allowedPurposes);
    if (bad.size > 0) {
      setInvalid(bad);
      return;
    }
    setInvalid(new Set());
    setSaved(false);
    setPublished(false);
    create.reset();
    publish.reset();
    create.mutate({ eventType: entry.eventType, definition: definitionFromForm(form) }, { onSuccess: () => setSaved(true) });
  };

  const confirmPublish = (event: FormEvent): void => {
    event.preventDefault();
    if (publishing === undefined || busy || !canWrite) return;
    if (!isPublishReasonValid(reason)) {
      setReasonInvalid(true);
      return;
    }
    setSaved(false);
    create.reset();
    publish.mutate(
      { eventType: entry.eventType, workflowId: publishing.id, version: publishing.version, reason: reason.trim() },
      {
        onSuccess: () => {
          setPublished(true);
          setPublishing(undefined);
          setReason('');
          setReasonInvalid(false);
        },
      },
    );
  };

  const openPublish = (workflow: WorkflowView): void => {
    create.reset();
    publish.reset();
    setSaved(false);
    setPublished(false);
    setReason('');
    setReasonInvalid(false);
    setPublishing(workflow);
  };

  return (
    <>
      {canWrite ? (
        <form onSubmit={submit} noValidate aria-label={t('not.workflow.form.aria')} className="billing-issue">
          <h2>{t('not.workflow.form.title')}</h2>
          <div className="field">
            <label htmlFor="workflow-purpose">{t('not.workflow.form.purpose.label')}</label>
            <select id="workflow-purpose" value={form.purpose} aria-invalid={invalid.has('purpose')} onChange={(event) => update({ purpose: event.target.value })}>
              {entry.allowedPurposes.map((purpose) => (
                <option key={purpose} value={purpose}>
                  {purposeLabel(t, purpose)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="workflow-priority">{t('not.workflow.form.priority.label')}</label>
            <select
              id="workflow-priority"
              value={form.priority}
              onChange={(event) => {
                const priority = event.target.value as Priority;
                // The quiet hours are overridden by a CRITICAL message only.
                update(priority === 'CRITICAL' ? { priority } : { priority, quietHoursOverride: false, overrideReason: '' });
              }}
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priorityLabel(t, priority)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="workflow-resolver">{t('not.workflow.form.resolver.label')}</label>
            <select id="workflow-resolver" value={form.resolverKind} onChange={(event) => update({ resolverKind: event.target.value as DesignerForm['resolverKind'] })}>
              <option value="explicit">{t('not.workflow.form.resolver.explicit')}</option>
              <option value="role-in-scope">{t('not.workflow.form.resolver.roles')}</option>
            </select>
            {form.resolverKind === 'role-in-scope' ? (
              <>
                <label htmlFor="workflow-roles">{t('not.workflow.form.roles.label')}</label>
                <input id="workflow-roles" type="text" value={form.roles} aria-invalid={invalid.has('roles')} onChange={(event) => update({ roles: event.target.value })} />
                {invalid.has('roles') ? (
                  <small role="alert" className="field-error">
                    {t('not.workflow.form.roles.invalid')}
                  </small>
                ) : null}
              </>
            ) : null}
          </div>
          <fieldset className="field" data-channels>
            <legend>{t('not.workflow.form.channels.legend')}</legend>
            <p className="sub">{t('not.workflow.form.channels.fallback')}</p>
            <p className="sub">{t('not.workflow.form.channels.inbox')}</p>
            {form.channels.map((row, index) => (
              <div key={row.channel} className="row gap" data-channel={row.channel}>
                <label>
                  <input type="checkbox" checked={row.enabled || (row.channel === 'IN_APP' && inboxIsForced(form.priority))} disabled={row.channel === 'IN_APP' && inboxIsForced(form.priority)} onChange={(event) => update({ channels: form.channels.map((candidate, at) => (at === index ? { ...candidate, enabled: event.target.checked } : candidate)) })} />{' '}
                  {channelLabel(t, row.channel)}
                </label>
                {row.channel !== 'IN_APP' && row.enabled ? (
                  <input
                    type="text"
                    aria-label={t('not.workflow.form.template.label', { channel: channelLabel(t, row.channel) })}
                    value={row.templateCode}
                    onChange={(event) => update({ channels: form.channels.map((candidate, at) => (at === index ? { ...candidate, templateCode: event.target.value } : candidate)) })}
                  />
                ) : null}
                <button type="button" aria-label={t('not.workflow.form.channels.up', { channel: channelLabel(t, row.channel) })} disabled={index <= 1} onClick={() => update({ channels: moveChannel(form.channels, index, -1) })}>
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={t('not.workflow.form.channels.down', { channel: channelLabel(t, row.channel) })}
                  disabled={row.channel === 'IN_APP' || index === form.channels.length - 1}
                  onClick={() => update({ channels: moveChannel(form.channels, index, 1) })}
                >
                  ↓
                </button>
              </div>
            ))}
            {invalid.has('channels') ? (
              <small role="alert" className="field-error">
                {t('not.workflow.form.channels.none')}
              </small>
            ) : null}
            {invalid.has('templates') ? (
              <small role="alert" className="field-error">
                {t('not.workflow.form.template.invalid')}
              </small>
            ) : null}
          </fieldset>
          <div className="field">
            <label>
              <input type="checkbox" checked={form.ackRequired} onChange={(event) => update({ ackRequired: event.target.checked })} /> {t('not.workflow.form.ack.label')}
            </label>
          </div>
          <div className="field">
            <label htmlFor="workflow-expiry">{t('not.workflow.form.expiry.label', { min: MIN_EXPIRY_MINUTES, max: MAX_EXPIRY_MINUTES })}</label>
            <input id="workflow-expiry" type="number" inputMode="numeric" value={form.expiresAfterMinutes} aria-invalid={invalid.has('expiry')} onChange={(event) => update({ expiresAfterMinutes: event.target.value })} />
            {invalid.has('expiry') ? (
              <small role="alert" className="field-error">
                {t('not.workflow.form.expiry.invalid', { min: MIN_EXPIRY_MINUTES, max: MAX_EXPIRY_MINUTES })}
              </small>
            ) : null}
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={form.quietHoursOverride} disabled={form.priority !== 'CRITICAL'} onChange={(event) => update({ quietHoursOverride: event.target.checked })} />{' '}
              {t('not.workflow.form.override.label')}
            </label>
            <small className="sub">{t('not.workflow.form.override.hint')}</small>
            {form.quietHoursOverride ? (
              <>
                <label htmlFor="workflow-override-reason">{t('not.workflow.form.overrideReason.label')}</label>
                <textarea
                  id="workflow-override-reason"
                  rows={2}
                  maxLength={MAX_OVERRIDE_REASON}
                  value={form.overrideReason}
                  aria-invalid={invalid.has('override')}
                  onChange={(event) => update({ overrideReason: event.target.value })}
                />
              </>
            ) : null}
            {invalid.has('override') ? (
              <small role="alert" className="field-error">
                {t('not.workflow.form.override.invalid', { min: MIN_OVERRIDE_REASON })}
              </small>
            ) : null}
          </div>
          {saved ? (
            <p className="callout" role="status">
              {t('not.workflow.done.drafted')}
            </p>
          ) : null}
          <div className="row gap">
            <button type="submit" className="primary" disabled={busy}>
              {t('not.workflow.form.submit.action')}
            </button>
          </div>
        </form>
      ) : null}
      {published ? (
        <p className="callout" role="status">
          {t('not.workflow.done.published')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <div className="callout warning" role="alert">
          <p>{problemMessage(t, problem)}</p>
        </div>
      )}
      <h2>{t('not.workflow.list.title')}</h2>
      <StateBoundary state={state} onRetry={() => void workflows.refetch()}>
        {items.length === 0 ? (
          <p className="sub" role="status">
            {t('not.workflow.list.none')}
          </p>
        ) : (
          <div className="tablewrap">
            <table data-workflows>
              <thead>
                <tr>
                  <th>{t('not.workflow.col.revision')}</th>
                  <th>{t('not.workflow.col.status')}</th>
                  <th>{t('not.workflow.col.priority')}</th>
                  <th>{t('not.workflow.col.channels')}</th>
                  <th>{t('not.workflow.col.published')}</th>
                  <th>
                    <span className="sr-only">{t('not.workflow.col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((workflow) => (
                  <tr key={workflow.id} data-workflow-id={workflow.id} data-status={workflow.status}>
                    <td>{workflow.revision}</td>
                    <td>
                      <span className={statusPill(workflow.status)}>{statusLabel(t, workflow.status)}</span>
                    </td>
                    <td>
                      {priorityLabel(t, workflow.definition.priority)}
                      {workflow.definition.quietHoursOverride ? <small className="sub"> · {t('not.workflow.col.override')}</small> : null}
                    </td>
                    <td data-plan>{workflow.definition.channels.map((step) => channelLabel(t, step.channel)).join(' → ')}</td>
                    <td>{workflow.publishedAt === undefined ? '—' : day(workflow.publishedAt)}</td>
                    <td>
                      {canWrite && canPublish(workflow) ? (
                        <button type="button" disabled={busy} onClick={() => openPublish(workflow)}>
                          {t('not.workflow.publish.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {workflows.hasNextPage ? (
          <div className="row gap">
            <button type="button" disabled={workflows.isFetchingNextPage} onClick={() => void workflows.fetchNextPage()}>
              {t('not.workflow.list.more.action')}
            </button>
          </div>
        ) : null}
      </StateBoundary>
      {publishing === undefined ? null : (
        <form onSubmit={confirmPublish} noValidate aria-label={t('not.workflow.publish.aria')} className="billing-issue">
          <p className="callout">{t('not.workflow.publish.rule', { revision: publishing.revision })}</p>
          <dl className="kv" data-draft-definition>
            <dt>{t('not.workflow.review.purpose')}</dt>
            <dd>{purposeLabel(t, publishing.definition.purpose)}</dd>
            <dt>{t('not.workflow.review.priority')}</dt>
            <dd>{priorityLabel(t, publishing.definition.priority)}</dd>
            <dt>{t('not.workflow.review.recipients')}</dt>
            <dd data-recipients>{publishing.definition.resolver === 'role-in-scope' ? t('not.workflow.review.roles', { roles: publishing.definition.roles.join(', ') }) : t('not.workflow.form.resolver.explicit')}</dd>
            <dt>{t('not.workflow.review.channels')}</dt>
            <dd data-review-plan>{publishing.definition.channels.map((step) => (step.templateCode === undefined ? channelLabel(t, step.channel) : `${channelLabel(t, step.channel)} (${step.templateCode})`)).join(' → ')}</dd>
            <dt>{t('not.workflow.review.ack')}</dt>
            <dd>{publishing.definition.ackRequired ? t('not.workflow.review.yes') : t('not.workflow.review.no')}</dd>
            <dt>{t('not.workflow.review.expiry')}</dt>
            <dd>{t('not.workflow.review.minutes', { minutes: publishing.definition.expiresAfterMinutes })}</dd>
            <dt>{t('not.workflow.review.override')}</dt>
            <dd data-review-override>{publishing.definition.quietHoursOverride ? t('not.workflow.review.overrideYes', { reason: publishing.definition.overrideReason ?? '' }) : t('not.workflow.review.no')}</dd>
          </dl>
          <div className="field">
            <label htmlFor="workflow-publish-reason">{t('not.workflow.publish.reason.label')}</label>
            <textarea id="workflow-publish-reason" rows={2} maxLength={MAX_PUBLISH_REASON} value={reason} aria-invalid={reasonInvalid} onChange={(event) => setReason(event.target.value)} />
            {reasonInvalid ? (
              <small role="alert" className="field-error">
                {t('not.workflow.publish.reason.tooShort')}
              </small>
            ) : null}
          </div>
          <div className="row gap">
            <button type="submit" className="primary" disabled={busy}>
              {t('not.workflow.publish.confirm.action')}
            </button>
            <button type="button" onClick={() => setPublishing(undefined)}>
              {t('not.workflow.publish.abort.action')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
