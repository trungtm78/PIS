import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useProjectOptions } from '../../dir/hooks';
import { useThreadCommand } from './hooks';
import { LINK_KINDS, describeLinkRefusal, emptyLink, linkBody, linkProblem } from './link-model';
import type { LinkDraft, LinkKind } from './link-model';
import type { Conversation } from './model';

/** The permission that answers in a conversation also ties it to a record (the operation `linkConversationResource`). */
function useLinkResource(conversationId: string) {
  return useThreadCommand<{ conversationId: string; version: number; body: { resource_type: LinkKind; resource_id: string } }>(conversationId, (client, input, attempt) =>
    client.command('linkConversationResource', { path: { conversationId: input.conversationId }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

interface Props {
  conversation: Conversation;
  onDone(notice: string): void;
}

/**
 * Ties the conversation to a project, an issue or a contract that the person reaches, so that the agents of the project see it. The server judges the scope: a record outside it is refused like a record that does not exist.
 * A project is chosen from the list the person reaches; an issue or a contract is named by its identifier.
 */
export function LinkPanel({ conversation, onDone }: Props) {
  const { t } = useTranslation();
  const link = useLinkResource(conversation.id);
  const projects = useProjectOptions();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LinkDraft>(emptyLink);
  const [tried, setTried] = useState(false);
  const problem = tried ? linkProblem(draft) : undefined;
  const refusal = link.isError ? describeLinkRefusal(link.error) : undefined;
  const kindLabel = (kind: LinkKind): string => (kind === 'project' ? t('omni.link.kind.project') : kind === 'issue' ? t('omni.link.kind.issue') : t('omni.link.kind.contract'));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (link.isPending || linkProblem(draft) !== undefined) return;
    link.mutate(
      { conversationId: conversation.id, version: conversation.version, body: linkBody(draft) },
      {
        onSuccess: () => {
          setOpen(false);
          setDraft(emptyLink);
          setTried(false);
          onDone(t('omni.link.done'));
        },
      },
    );
  };
  return (
    <div className="card" data-link-panel>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-link-open>
        {t('omni.link.open')}
      </button>
      {open ? (
        <form onSubmit={submit} noValidate aria-label={t('omni.link.form.aria')} data-link-form>
          <p className="sub">{t('omni.link.help')}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-link-problem>
              {refusal === 'scope' ? t('omni.link.refused.scope') : refusal === 'conversationState' ? t('omni.link.refused.state') : refusal === 'conflict' ? t('omni.link.refused.conflict') : refusal === 'validation' ? t('omni.link.refused.validation') : t('omni.link.refused.general')}
            </p>
          )}
          <label htmlFor="link-kind">{t('omni.link.kind.label')}</label>
          <select id="link-kind" value={draft.kind} onChange={(event) => setDraft({ kind: event.target.value as LinkKind, resourceId: '' })}>
            {LINK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(kind)}
              </option>
            ))}
          </select>
          <label htmlFor="link-resource">{t('omni.link.resource.label')}</label>
          {draft.kind === 'project' && !projects.isError ? (
            <select id="link-resource" value={draft.resourceId} onChange={(event) => setDraft({ ...draft, resourceId: event.target.value })} disabled={projects.isLoading} aria-invalid={problem !== undefined}>
              <option value="">{projects.isLoading ? t('omni.link.loading') : t('omni.link.project.choose')}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.label}
                </option>
              ))}
            </select>
          ) : (
            <input id="link-resource" value={draft.resourceId} onChange={(event) => setDraft({ ...draft, resourceId: event.target.value })} aria-invalid={problem !== undefined} />
          )}
          {draft.kind === 'project' && projects.isError ? (
            <small role="status" data-link-lookup-error>
              {t('omni.link.lookup.error')}
            </small>
          ) : null}
          {problem === undefined ? null : (
            <small role="alert" className="field-error" data-link-field-problem>
              {problem === 'required' ? t('omni.link.error.required') : t('omni.link.error.uuid')}
            </small>
          )}
          <button type="submit" className="primary" disabled={link.isPending}>
            {link.isPending ? t('omni.link.sending') : t('omni.link.submit')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
