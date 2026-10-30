import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { workspaceLink } from '../iss/issue-model';
import '../not/delivery/delivery.css';
import { channelLabel, statusLabel, statusPill } from './conversation/labels';
import { conversationLink } from './conversation/model';
import { useConversionOptions, useConvert, useConvertible } from './conversion/hooks';
import { problemMessage } from './conversion/labels';
import { CONVERT_PERMISSION, READ_PERMISSION, SUMMARY_MAX, conversionBody, describeProblem, draftProblems, emptyDraft, mayConvert } from './conversion/model';
import type { ConversionOptions, ConvertibleConversation, Draft, Field } from './conversion/model';
import { shownError } from './thread/model';

/**
 * OMNI-09: turn a conversation into an issue of a project. The agent chooses among the projects they are scoped to and the categories the tenant defined, and writes a summary: only the summary and the address of the conversation
 * go into the issue, never the words of the person (BR-OMNI-07). A conversation is turned into one issue; after that this screen shows where it went. The server judges the scope and the category; what it refuses is told in words.
 */
export default function ConversationConvertScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <ConvertContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ConvertContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say: the screen shows the conversation and no form.
  const frozen = mode === 'READ_ONLY';
  const [search] = useSearchParams();
  const id = search.get('id') ?? undefined;
  const canConvert = permissions === undefined || (permissions.includes(READ_PERMISSION) && permissions.includes(CONVERT_PERMISSION));
  const conversation = useConvertible(id, canConvert);
  const options = useConversionOptions(canConvert && id !== undefined);
  const state = useScreenState({
    isLoading: conversation.isLoading || options.isLoading,
    // A refresh that fails for a break in the network while there is something to show does not take the form away; a refusal does: the conversation may have gone out of the scope of the agent.
    error: shownError(conversation.error, conversation.data != null) ?? shownError(options.error, options.data !== undefined),
    data: conversation.data,
    isEmpty: (data: unknown) => data === null,
  });
  const current = conversation.data ?? undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue omni-convert">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.convert.page.title')}</h1>
          <p>{id === undefined ? <Link to="/omni/omni-01">{t('omni.convert.back.inbox')}</Link> : <Link to={conversationLink(id)}>{t('omni.convert.back.action')}</Link>}</p>
        </div>
      </div>
      <p className="callout" data-privacy-notice>
        {t('omni.convert.privacy.notice')}
      </p>
      <StateBoundary state={id === undefined ? 'empty' : canConvert ? state : 'denied'} onRetry={() => void Promise.all([conversation.refetch(), options.refetch()])}>
        {current === undefined || options.data === undefined ? null : <Body conversation={current} options={options.data} frozen={frozen} />}
      </StateBoundary>
    </section>
  );
}

function Body({ conversation, options, frozen }: { conversation: ConvertibleConversation; options: ConversionOptions; frozen: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="card" data-conversation-header>
        <h2>{conversation.contactName}</h2>
        <p>
          {channelLabel(t, conversation.channel)} · {conversation.accountName} ·{' '}
          <span className={statusPill(conversation.status)} data-conversation-status>
            {statusLabel(t, conversation.status)}
          </span>
        </p>
      </div>
      {conversation.issueId !== undefined ? (
        <p className="callout" role="status" data-converted>
          {t('omni.convert.converted.notice')} <Link to={workspaceLink(conversation.issueId)}>{t('omni.convert.issue.open.action')}</Link>
        </p>
      ) : !mayConvert(conversation) ? (
        <p className="callout warning" role="status" data-closed>
          {t('omni.convert.closed.notice')}
        </p>
      ) : frozen ? (
        <p className="callout warning" role="status" data-frozen>
          {t('omni.convert.frozen.notice')}
        </p>
      ) : (
        // The form belongs to the conversation as it was read: a refresh that moves its version starts nothing over, but a change of conversation does.
        <ConvertForm key={conversation.id} conversation={conversation} options={options} />
      )}
    </>
  );
}

function ConvertForm({ conversation, options }: { conversation: ConvertibleConversation; options: ConversionOptions }) {
  const { t } = useTranslation();
  const convert = useConvert(conversation.id);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [invalid, setInvalid] = useState<Field[]>([]);
  const problem = convert.isError ? describeProblem(convert.error) : undefined;
  const fieldProblem = (field: Field): boolean => invalid.includes(field);
  const noChoice = options.projects.length === 0 || options.issueTypes.length === 0;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (convert.isPending) return;
    const found = draftProblems(draft);
    setInvalid(found);
    if (found.length > 0) return;
    convert.reset();
    // The version the conversation was read at goes with it: a conversation that someone else moved meanwhile is a conflict.
    convert.mutate({ conversationId: conversation.id, version: conversation.version, body: conversionBody(draft) });
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('omni.convert.form.aria')} className="card" data-convert-form>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {noChoice ? (
        <p className="callout warning" role="status" data-no-choice>
          {t('omni.convert.options.none')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="convert-project">{t('omni.convert.project.label')}</label>
        <select id="convert-project" value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })} aria-invalid={fieldProblem('projectId')}>
          <option value="">{t('omni.convert.project.choose')}</option>
          {options.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.code} · {project.name}
            </option>
          ))}
        </select>
        {fieldProblem('projectId') ? (
          <small role="alert" className="field-error" data-project-problem>
            {t('omni.convert.project.invalid')}
          </small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="convert-type">{t('omni.convert.type.label')}</label>
        <select id="convert-type" value={draft.issueType} onChange={(event) => setDraft({ ...draft, issueType: event.target.value })} aria-invalid={fieldProblem('issueType')}>
          <option value="">{t('omni.convert.type.choose')}</option>
          {options.issueTypes.map((type) => (
            <option key={type.code} value={type.code}>
              {type.label}
            </option>
          ))}
        </select>
        {fieldProblem('issueType') ? (
          <small role="alert" className="field-error" data-type-problem>
            {t('omni.convert.type.invalid')}
          </small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="convert-summary">{t('omni.convert.summary.label', { max: SUMMARY_MAX })}</label>
        <textarea id="convert-summary" value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} aria-invalid={fieldProblem('summary')} />
        {fieldProblem('summary') ? (
          <small role="alert" className="field-error" data-summary-problem>
            {t('omni.convert.summary.invalid', { max: SUMMARY_MAX })}
          </small>
        ) : null}
      </div>
      <button type="submit" className="primary" disabled={convert.isPending || noChoice}>
        {t('omni.convert.submit.action')}
      </button>
    </form>
  );
}
