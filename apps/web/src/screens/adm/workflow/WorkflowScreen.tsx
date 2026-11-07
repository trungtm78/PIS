import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useCreateDraft, usePublish, useUpdateDraft, useVersions } from './hooks';
import { businessTypeLabel, defectLabel, diffLabel, problemMessage, ruleTypeLabel, statusLabel, statusTone, stepProblemMessage, timeoutLabel } from './labels';
import { BUSINESS_TYPES, MANAGE_PERMISSION, PUBLISH_PERMISSION, READ_PERMISSION, RULE_TYPES, TIMEOUTS, commandsOf, describeProblem, diffDefinitions, emptyStep, fromDefinition, localProblems, readDefects, toDefinition } from './model';
import type { StepForm, VersionView } from './model';
import { FilterPanel, SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { toneOfPill } from '../kit-tone';
import '../adm-kit.css';

type Editing = { kind: 'new' } | { kind: 'draft'; version: VersionView };

/**
 * ADM-06: the approval workflows of the tenant (ST-ADM-012, ADM 3.7). A business type has one workflow in force; an administrator writes the next one as a draft in the step builder, the server says where a definition is wrong by
 * its JSON path, and another administrator publishes it. Approvals that run keep the version they started under; only those that start afterwards use the new one.
 */
export default function WorkflowScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <WorkflowContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkflowContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [businessType, setBusinessType] = useState<string>(BUSINESS_TYPES[0].code);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [publishing, setPublishing] = useState<VersionView | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const mayWrite = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const mayPublish = (permissions === undefined || permissions.includes(PUBLISH_PERMISSION)) && mode !== 'READ_ONLY';
  const versions = useVersions(businessType, mayRead);
  const queryState = useScreenState({ isLoading: versions.isLoading, error: versions.error, data: versions.data, isEmpty: () => false });
  const state = mayRead ? queryState : 'denied';
  const list = versions.data ?? [];
  const selected = list.find((entry) => entry.id === chosen) ?? list[0];
  const previous = selected === undefined ? undefined : list.find((entry) => entry.revision === selected.revision - 1);
  const moment = (iso: string | null): string => (iso === null || iso === '' ? t('adm.workflow.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));
  const inForce = list.find((entry) => entry.status === 'Published');
  const changes = selected === undefined || previous === undefined ? undefined : diffDefinitions(previous.definition, selected.definition);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.workflow.title')}</h1>
          <p>{t('adm.workflow.subtitle')}</p>
        </div>
        {mayWrite ? (
          <button type="button" className="ui-button ui-button--primary" data-action="new" onClick={() => setEditing({ kind: 'new' })}>
            {t('adm.workflow.new.action')}
          </button>
        ) : null}
      </div>
      <FilterPanel>
        <div className="field">
          <label htmlFor="workflow-type">{t('adm.workflow.field.businessType')}</label>
          <select
            id="workflow-type"
            value={businessType}
            onChange={(event) => {
              setBusinessType(event.target.value);
              setChosen(undefined);
              setEditing(undefined);
            }}
          >
            {BUSINESS_TYPES.map((type) => (
              <option key={type.code} value={type.code}>
                {businessTypeLabel(t, type.code)}
              </option>
            ))}
          </select>
        </div>
      </FilterPanel>
      {inForce === undefined ? (
        <p className="callout warning" role="status" data-testid="not-configured">
          {t('adm.workflow.notConfigured')}
        </p>
      ) : (
        <p className="adm-kit-sub" data-testid="in-force">
          {t('adm.workflow.inForce', { revision: inForce.revision, at: moment(inForce.publishedAt) })}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void versions.refetch()}>
        <SectionCard title={t('adm.workflow.versions.title')}>
          {list.length === 0 ? (
            <p className="sub" data-testid="no-versions">
              {t('adm.workflow.versions.none')}
            </p>
          ) : (
            <KitTable caption={t('w2adm.workflow.table.caption')} testId="versions">
              <thead>
                <tr>
                  <th scope="col">{t('adm.workflow.column.revision')}</th>
                  <th scope="col">{t('adm.workflow.column.status')}</th>
                  <th scope="col">{t('adm.workflow.column.steps')}</th>
                  <th scope="col">{t('adm.workflow.column.published')}</th>
                  <th scope="col">
                    {t('adm.workflow.column.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((entry) => (
                  <tr key={entry.id} data-version={entry.id} data-selected={entry.id === selected?.id ? 'yes' : 'no'}>
                    <td>{entry.revision}</td>
                    <td>
                      <span data-testid="status">
                        <StatusPill tone={toneOfPill(`pill ${statusTone(entry.status)}`)}>{statusLabel(t, entry.status)}</StatusPill>
                      </span>
                    </td>
                    <td>{fromDefinition(entry.definition).length}</td>
                    <td>{moment(entry.publishedAt)}</td>
                    <td>
                      <button type="button" data-action="open" onClick={() => setChosen(entry.id)}>
                        {t('adm.workflow.open.action')}
                      </button>{' '}
                      {entry.status === 'Draft' && mayWrite ? (
                        <button type="button" data-action="edit" onClick={() => setEditing({ kind: 'draft', version: entry })}>
                          {t('adm.workflow.edit.action')}
                        </button>
                      ) : null}{' '}
                      {entry.status === 'Draft' && mayPublish ? (
                        <button type="button" className="ui-button ui-button--primary" data-action="publish" onClick={() => setPublishing(entry)}>
                          {t('adm.workflow.publish.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
        </SectionCard>
        {selected === undefined ? null : (
          <div className="card" data-testid="detail">
            <h2>{t('adm.workflow.detail.title', { revision: selected.revision })}</h2>
            <ol data-testid="steps">
              {fromDefinition(selected.definition).map((step) => (
                <li key={step.id} data-step={step.id}>
                  <strong>{step.name}</strong> <small className="sub">{step.id}</small>
                  <br />
                  {ruleTypeLabel(t, step.ruleType)} · {t('adm.workflow.summary.approvals', { count: step.minApprovals })} · {t('adm.workflow.summary.sla', { hours: step.slaHours })} · {timeoutLabel(t, step.onTimeout)}
                  {step.allowReturnTo === '' ? null : ` · ${t('adm.workflow.summary.returnTo', { id: step.allowReturnTo })}`}
                  {step.ruleType === 'ROLE_IN_UNIT' ? (
                    <small className="sub" data-testid="operand-role">
                      {' '}
                      · {t('adm.workflow.summary.role', { role: step.roleCode, unit: step.unitId })}
                    </small>
                  ) : null}
                  {step.ruleType === 'SPECIFIC' ? (
                    <small className="sub" data-testid="operand-members">
                      {' '}
                      · {t('adm.workflow.summary.members', { members: step.members })}
                    </small>
                  ) : null}
                  {step.onTimeout === 'ESCALATE' ? (
                    <small className="sub" data-testid="operand-escalate">
                      {' '}
                      · {t('adm.workflow.summary.escalate', { id: step.escalateTo })}
                    </small>
                  ) : null}
                </li>
              ))}
            </ol>
            <h3>{t('adm.workflow.diff.title')}</h3>
            {changes === undefined ? (
              <p className="sub" data-testid="no-previous">
                {t('adm.workflow.diff.first')}
              </p>
            ) : changes.length === 0 ? (
              <p className="sub" data-testid="no-changes">
                {t('adm.workflow.diff.none', { revision: selected.revision - 1 })}
              </p>
            ) : (
              <ul data-testid="changes">
                {changes.map((difference) => (
                  <li key={`${difference.kind}-${difference.id}`} data-change={difference.kind}>
                    {diffLabel(t, difference)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </StateBoundary>
      {editing === undefined ? null : <Builder businessType={businessType} editing={editing} base={inForce} onClose={() => setEditing(undefined)} />}
      {publishing === undefined ? null : <PublishDialog version={publishing} onClose={() => setPublishing(undefined)} />}
      <p className="prototype-note">{t('adm.workflow.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Builder({ businessType, editing, base, onClose }: { businessType: string; editing: Editing; base: VersionView | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateDraft();
  const update = useUpdateDraft();
  const command = editing.kind === 'new' ? create : update;
  // A new draft starts from the workflow in force, so that a change is a change and not a rewrite.
  const [steps, setSteps] = useState<StepForm[]>(() => {
    const source = editing.kind === 'draft' ? editing.version.definition : base?.definition;
    const loaded = fromDefinition(source);
    return loaded.length > 0 ? loaded : [emptyStep(0)];
  });
  const [submitted, setSubmitted] = useState(false);
  const problems = localProblems(steps);
  const defects = command.isError ? readDefects(command.error) : [];
  const set = (index: number, patch: Partial<StepForm>): void => setSteps(steps.map((step, position) => (position === index ? { ...step, ...patch } : step)));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (command.isPending || problems.some((entry) => Object.keys(entry).length > 0)) return;
    const definition = toDefinition(businessType, steps);
    if (editing.kind === 'new') create.mutate({ businessType, definition }, { onSuccess: onClose });
    else update.mutate({ id: editing.version.id, version: editing.version.version, businessType, definition }, { onSuccess: onClose });
  };
  const commands = commandsOf(businessType);
  return (
    <CommandFrame
      title={editing.kind === 'new' ? t('adm.workflow.builder.new') : t('adm.workflow.builder.edit', { revision: editing.version.revision })}
      refusal={command.isError ? problemMessage(t, describeProblem(command.error)) : undefined}
      pending={command.isPending}
      submitLabel={t('adm.workflow.builder.save')}
      words={{ close: t('adm.workflow.dialog.close'), cancel: t('adm.workflow.dialog.cancel'), pending: t('adm.workflow.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      {defects.length === 0 ? null : (
        <section className="callout warning" role="alert" aria-label={t('adm.workflow.invalid.title')} data-testid="defects">
          <strong>{t('adm.workflow.invalid.title')}</strong>
          <ul>
            {defects.map((defect) => (
              <li key={`${defect.path}:${defect.code}`} data-path={defect.path}>
                <code>{defect.path}</code> {defectLabel(t, defect.code)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <fieldset disabled={command.isPending}>
        {steps.map((step, index) => (
          <section key={index} className="card" data-step-form={index} aria-label={t('adm.workflow.builder.step', { n: index + 1 })}>
            <h3>{t('adm.workflow.builder.step', { n: index + 1 })}</h3>
            <Field id={`step-${index}-id`} label={t('adm.workflow.field.id')} error={submitted && problems[index]?.id !== undefined ? stepProblemMessage(t, problems[index].id) : undefined}>
              <input id={`step-${index}-id`} value={step.id} maxLength={40} onChange={(event) => set(index, { id: event.target.value })} />
            </Field>
            <Field id={`step-${index}-name`} label={t('adm.workflow.field.name')} error={submitted && problems[index]?.name !== undefined ? stepProblemMessage(t, problems[index].name) : undefined}>
              <input id={`step-${index}-name`} value={step.name} maxLength={120} onChange={(event) => set(index, { name: event.target.value })} />
            </Field>
            <Field id={`step-${index}-rule`} label={t('adm.workflow.field.assignee')} error={undefined}>
              <select id={`step-${index}-rule`} value={step.ruleType} onChange={(event) => set(index, { ruleType: event.target.value as StepForm['ruleType'] })}>
                {RULE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ruleTypeLabel(t, type)}
                  </option>
                ))}
              </select>
            </Field>
            {step.ruleType === 'ROLE_IN_UNIT' ? (
              <>
                <Field id={`step-${index}-role`} label={t('adm.workflow.field.roleCode')} error={undefined}>
                  <input id={`step-${index}-role`} value={step.roleCode} maxLength={60} onChange={(event) => set(index, { roleCode: event.target.value })} />
                </Field>
                <Field id={`step-${index}-unit`} label={t('adm.workflow.field.unit')} error={undefined}>
                  <input id={`step-${index}-unit`} value={step.unitId} maxLength={36} onChange={(event) => set(index, { unitId: event.target.value })} />
                </Field>
              </>
            ) : null}
            {step.ruleType === 'SPECIFIC' ? (
              <Field id={`step-${index}-members`} label={t('adm.workflow.field.members')} error={undefined} hint={t('adm.workflow.field.members.hint')}>
                <textarea id={`step-${index}-members`} value={step.members} onChange={(event) => set(index, { members: event.target.value })} />
              </Field>
            ) : null}
            <Field id={`step-${index}-min`} label={t('adm.workflow.field.minApprovals')} error={submitted && problems[index]?.minApprovals !== undefined ? stepProblemMessage(t, problems[index].minApprovals) : undefined}>
              <input id={`step-${index}-min`} inputMode="numeric" value={step.minApprovals} maxLength={2} onChange={(event) => set(index, { minApprovals: event.target.value })} />
            </Field>
            <Field id={`step-${index}-sla`} label={t('adm.workflow.field.sla')} error={submitted && problems[index]?.slaHours !== undefined ? stepProblemMessage(t, problems[index].slaHours) : undefined}>
              <input id={`step-${index}-sla`} inputMode="decimal" value={step.slaHours} maxLength={6} onChange={(event) => set(index, { slaHours: event.target.value })} />
            </Field>
            <Field id={`step-${index}-timeout`} label={t('adm.workflow.field.onTimeout')} error={undefined}>
              <select id={`step-${index}-timeout`} value={step.onTimeout} onChange={(event) => set(index, { onTimeout: event.target.value as StepForm['onTimeout'] })}>
                {TIMEOUTS.map((timeout) => (
                  <option key={timeout} value={timeout}>
                    {timeoutLabel(t, timeout)}
                  </option>
                ))}
              </select>
            </Field>
            {step.onTimeout === 'ESCALATE' ? (
              <Field id={`step-${index}-escalate`} label={t('adm.workflow.field.escalateTo')} error={undefined}>
                <input id={`step-${index}-escalate`} value={step.escalateTo} maxLength={36} onChange={(event) => set(index, { escalateTo: event.target.value })} />
              </Field>
            ) : null}
            {index === 0 ? null : (
              <Field id={`step-${index}-return`} label={t('adm.workflow.field.returnTo')} error={undefined}>
                <select id={`step-${index}-return`} value={step.allowReturnTo} onChange={(event) => set(index, { allowReturnTo: event.target.value })}>
                  <option value="">{t('adm.workflow.field.returnTo.none')}</option>
                  {steps.slice(0, index).map((earlier) => (
                    <option key={earlier.id} value={earlier.id}>
                      {earlier.id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {steps.length > 1 ? (
              <button type="button" data-action="remove-step" onClick={() => setSteps(steps.filter((_, position) => position !== index))}>
                {t('adm.workflow.builder.remove')}
              </button>
            ) : null}
          </section>
        ))}
        <button type="button" data-action="add-step" disabled={steps.length >= 10} onClick={() => setSteps([...steps, emptyStep(steps.length)])}>
          {t('adm.workflow.builder.add')}
        </button>
        <dl className="dgv-facts" data-testid="terminal">
          <div>
            <dt>{t('adm.workflow.terminal.approved')}</dt>
            <dd>{commands?.approved}</dd>
          </div>
          <div>
            <dt>{t('adm.workflow.terminal.returned')}</dt>
            <dd>{commands?.returned}</dd>
          </div>
          <div>
            <dt>{t('adm.workflow.terminal.rejected')}</dt>
            <dd>{commands?.rejected}</dd>
          </div>
        </dl>
      </fieldset>
    </CommandFrame>
  );
}

function PublishDialog({ version, onClose }: { version: VersionView; onClose: () => void }) {
  const { t } = useTranslation();
  const publish = usePublish();
  const [reason, setReason] = useState(t('adm.workflow.publish.reason.default'));
  const [submitted, setSubmitted] = useState(false);
  const tooShort = reason.trim().length < 10;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (publish.isPending || tooShort) return;
    publish.mutate({ id: version.id, version: version.version, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.workflow.publish.title', { revision: version.revision })}
      refusal={publish.isError ? (readDefects(publish.error).length > 0 ? problemMessage(t, 'invalidDefinition') : problemMessage(t, describeProblem(publish.error))) : undefined}
      pending={publish.isPending}
      submitLabel={t('adm.workflow.publish.submit')}
      words={{ close: t('adm.workflow.dialog.close'), cancel: t('adm.workflow.dialog.cancel'), pending: t('adm.workflow.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={publish.isPending}>
        <p>{t('adm.workflow.publish.text')}</p>
        <Field id="publish-reason" label={t('adm.workflow.publish.reason')} error={submitted && tooShort ? t('adm.workflow.problem.reasonShort') : undefined}>
          <textarea id="publish-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
