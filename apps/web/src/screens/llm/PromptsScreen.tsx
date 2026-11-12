import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { evalProblemMessage, promptStatusLabel } from './eval-labels';
import { EMPTY_PROMPT, PROMPT_APPROVE, PROMPT_MANAGE, validatePrompt } from './eval-model';
import type { PromptEntry, PromptErrors, PromptValues } from './eval-model';
import { useApprovePrompt, useCreatePrompt, usePrompts, useRevisePrompt } from './hooks';
import { refusalMessage } from './labels';
import { describeLlmProblem } from './llm-model';
import './llm-kit.css';

/**
 * LLM-10: the prompts of the AI gateway (ST-LLM-004, LLM F4): a prompt is kept as a version (the template is held in the document store and only its hash is here) that is a draft until another person approves it; once
 * approved it does not change (a new version is made instead) and it takes the label PRODUCTION from the one that had it. The person who wrote a version cannot approve it.
 */
export default function PromptsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <PromptsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PromptsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const writable = mode !== 'READ_ONLY';
  const mayManage = (permissions === undefined || permissions.includes(PROMPT_MANAGE)) && writable;
  const mayApprove = (permissions === undefined || permissions.includes(PROMPT_APPROVE)) && writable;
  const prompts = usePrompts();
  const state = useScreenState({ isLoading: prompts.isLoading, error: prompts.error, data: prompts.data === undefined ? undefined : { rows: prompts.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.prompts.page.title')}</h1>
          <p>{t('llm.prompts.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void prompts.refetch()}>
        <p className="callout" data-testid="prompts-immutable-note">
          {t('llm.prompts.immutableNote')}
        </p>
        <div className="tablewrap" role="region" aria-label={t('llm.prompts.table.aria')} tabIndex={0}>
          <table className="table" data-testid="prompt-table" aria-label={t('llm.prompts.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.prompts.column.task')}</th>
                <th scope="col">{t('llm.prompts.column.name')}</th>
                <th scope="col">{t('llm.prompts.column.revision')}</th>
                <th scope="col">{t('llm.prompts.column.hash')}</th>
                <th scope="col">{t('llm.prompts.column.label')}</th>
                <th scope="col">{t('llm.prompts.column.status')}</th>
                <th scope="col">{t('llm.prompts.column.action')}</th>
              </tr>
            </thead>
            <tbody>
              {(prompts.data ?? []).map((prompt) => (
                <PromptRow key={prompt.id} entry={prompt} mayManage={mayManage} mayApprove={mayApprove} />
              ))}
            </tbody>
          </table>
        </div>
        {(prompts.data ?? []).length === 0 ? <p data-testid="prompts-none">{t('llm.prompts.none')}</p> : null}
        {mayManage ? <PromptCreateForm /> : null}
      </StateBoundary>
    </section>
  );
}

function PromptRow({ entry, mayManage, mayApprove }: { entry: PromptEntry; mayManage: boolean; mayApprove: boolean }) {
  const { t } = useTranslation();
  const approve = useApprovePrompt();
  const [editing, setEditing] = useState(false);
  const refused = approve.isError ? describeLlmProblem(approve.error) : undefined;
  const draft = entry.status === 'DRAFT';
  return (
    <>
      <tr data-prompt-id={entry.id} data-status={entry.status}>
        <td>{entry.taskType}</td>
        <td>{entry.name}</td>
        <td>{entry.revision}</td>
        <td>
          <code>{entry.sha256.slice(0, 12)}</code>
        </td>
        <td>{entry.label ?? t('llm.prompts.noLabel')}</td>
        <td>{promptStatusLabel(t, entry.status)}</td>
        <td>
          {draft && (mayManage || mayApprove) ? (
            <div className="mne-actions">
              {mayManage ? (
                <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={editing} onClick={() => setEditing(!editing)}>
                  {t('llm.prompts.revise')}
                </button>
              ) : null}
              {mayApprove ? (
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={approve.isPending} onClick={() => approve.mutate({ promptId: entry.id, version: entry.version })}>
                  {t('llm.prompts.approve')}
                </button>
              ) : null}
            </div>
          ) : null}
          {refused === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="prompt-refused">
              {refusalMessage(t, refused.reason, refused.detail)}
            </p>
          )}
        </td>
      </tr>
      {editing && draft ? (
        <tr data-revise-for={entry.id}>
          <td colSpan={7}>
            <PromptReviseForm entry={entry} onDone={() => setEditing(false)} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function PromptFields({ idPrefix, values, errors, set }: { idPrefix: string; values: PromptValues; errors: PromptErrors; set: <K extends keyof PromptValues>(field: K, value: PromptValues[K]) => void }) {
  const { t } = useTranslation();
  const message = (field: keyof PromptErrors): string | undefined => (errors[field] === undefined ? undefined : evalProblemMessage(t, errors[field]));
  return (
    <>
      <div className="mne-filters">
        <Field id={`${idPrefix}-task`} label={t('llm.prompts.form.task')} error={message('taskType')}>
          <input id={`${idPrefix}-task`} value={values.taskType} onChange={(event) => set('taskType', event.target.value)} maxLength={80} />
        </Field>
        <Field id={`${idPrefix}-name`} label={t('llm.prompts.form.name')} error={message('name')}>
          <input id={`${idPrefix}-name`} value={values.name} onChange={(event) => set('name', event.target.value)} maxLength={120} />
        </Field>
        <Field id={`${idPrefix}-key`} label={t('llm.prompts.form.key')} error={message('templateObjectKey')} hint={t('llm.prompts.form.keyHint')}>
          <input id={`${idPrefix}-key`} value={values.templateObjectKey} onChange={(event) => set('templateObjectKey', event.target.value)} maxLength={300} />
        </Field>
        <Field id={`${idPrefix}-hash`} label={t('llm.prompts.form.hash')} error={message('templateSha256')} hint={t('llm.prompts.form.hashHint')}>
          <input id={`${idPrefix}-hash`} value={values.templateSha256} onChange={(event) => set('templateSha256', event.target.value)} maxLength={64} />
        </Field>
      </div>
      <Field id={`${idPrefix}-input`} label={t('llm.prompts.form.input')} error={message('inputSchema')}>
        <textarea id={`${idPrefix}-input`} rows={4} value={values.inputSchema} onChange={(event) => set('inputSchema', event.target.value)} />
      </Field>
      <Field id={`${idPrefix}-output`} label={t('llm.prompts.form.output')} error={message('outputSchema')}>
        <textarea id={`${idPrefix}-output`} rows={4} value={values.outputSchema} onChange={(event) => set('outputSchema', event.target.value)} />
      </Field>
    </>
  );
}

function usePromptValues(initial: PromptValues) {
  const [values, setValues] = useState<PromptValues>(initial);
  const [errors, setErrors] = useState<PromptErrors>({});
  const set = <K extends keyof PromptValues>(field: K, value: PromptValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  return { values, errors, setErrors, set };
}

function PromptCreateForm() {
  const { t } = useTranslation();
  const create = useCreatePrompt();
  const { values, errors, setErrors, set } = usePromptValues(EMPTY_PROMPT);
  const refused = create.isError ? describeLlmProblem(create.error) : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validatePrompt(values);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate(values);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.prompts.form.title')}>
      <h2>{t('llm.prompts.form.title')}</h2>
      <p className="sub">{t('llm.prompts.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="prompt-create-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {create.isSuccess ? (
        <p className="callout" role="status" data-testid="prompt-saved">
          {t('llm.prompts.form.saved')}
        </p>
      ) : null}
      <PromptFields idPrefix="prompt" values={values} errors={errors} set={set} />
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
          {t('llm.prompts.form.submit')}
        </button>
      </div>
    </form>
  );
}

function PromptReviseForm({ entry, onDone }: { entry: PromptEntry; onDone: () => void }) {
  const { t } = useTranslation();
  const revise = useRevisePrompt();
  const { values, errors, setErrors, set } = usePromptValues({
    taskType: entry.taskType,
    name: entry.name,
    templateObjectKey: '',
    templateSha256: entry.sha256,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
  });
  const refused = revise.isError ? describeLlmProblem(revise.error) : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (revise.isPending) return;
    const found = validatePrompt(values);
    setErrors(found);
    if (Object.keys(found).length === 0) revise.mutate({ promptId: entry.id, version: entry.version, values }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={send} noValidate aria-label={t('llm.prompts.revise.title', { name: entry.name })}>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="prompt-revise-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      <PromptFields idPrefix={`revise-${entry.id}`} values={values} errors={errors} set={set} />
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={revise.isPending}>
          {t('llm.prompts.revise.submit')}
        </button>
      </div>
    </form>
  );
}
