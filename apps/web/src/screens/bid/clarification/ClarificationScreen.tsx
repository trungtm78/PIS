import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useProposals } from '../proposal/hooks';
import { useAnswerClarification, useClarification, useClarifications, useDeadlineClock } from './hooks';
import { READ_PERMISSION, canSend, declarationPath, holds, mayAnswer, readFailure, recipientsOf, withAnswerDraft, withoutAnswerDraft } from './model';
import type { AnswerDrafts, Clarification } from './model';
import { RequestCard } from './RequestCard';
import { SendPanel } from './SendPanel';
import './clarification.css';
import '../bid.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BID-11: the clarification requests to the contractors during the evaluation of bids (ST-BID-011, BID 3 F6, BR-BID-03). A member of the evaluation team asks the contractor of an opened proposal to explain
 * something in it, with a deadline; the contractor, as a guest of their own contractor, or the clerk who took their letter, answers with a document before the deadline, once. A contractor sees only what asks
 * them, never who asked or which finding of the analysis the question rests on. Nothing here is sent to everyone at once and nothing is answered for a contractor after the deadline.
 */
export default function ClarificationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The requests, what was typed and the answers belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ClarificationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ClarificationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search] = useSearchParams();
  const packageId = search.get('package') ?? '';
  const wantedProposal = search.get('proposal') ?? '';
  const allowed = holds(permissions, READ_PERMISSION);
  const mayAsk = canSend(permissions, mode) && packageId !== '';
  const openedId = UUID.test(search.get('clarification') ?? '') ? (search.get('clarification') ?? '').toLowerCase() : '';
  // A link to one request shows that request alone when no package is chosen.
  const single = openedId !== '' && packageId === '';
  const list = useClarifications(packageId, allowed && !single);
  const opened = useClarification(openedId, allowed && single);
  const read = single ? opened : list;
  const proposals = useProposals(mayAsk ? packageId : '');
  const proposalState = useScreenState({ isLoading: proposals.isLoading, error: proposals.error, data: proposals.data, isEmpty: () => false });
  const answer = useAnswerClarification();
  const [drafts, setDrafts] = useState<AnswerDrafts>({});
  const failure = readFailure(read.error);
  // A caller with no request is not an empty screen for the evaluation team: the question form stays where it is, outside the boundary.
  const state = useScreenState({ isLoading: read.isLoading, error: failure === undefined ? read.error : undefined, data: read.data, isEmpty: (data) => (data as Clarification[]).length === 0 });
  const lines = read.data ?? [];
  const recipients = recipientsOf(proposals.data ?? []);
  const packageCode = lines.find((line) => line.package.id === packageId)?.package.code ?? proposals.data?.[0]?.packageCode ?? '';
  useDeadlineClock(lines.filter((line) => line.status === 'SENT').map((line) => line.dueAt));
  const now = new Date();
  const send = (line: Clarification): void =>
    answer.mutate({ line, body: { answer_document_id: (drafts[line.id] ?? '').trim().toLowerCase() } }, { onSuccess: () => setDrafts((current) => withoutAnswerDraft(current, line.id)) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.clarifications.page.title')}</h1>
          <p>{t('bid.clarifications.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? 'default' : 'denied'}>
        {failure === 'undeclared' ? (
          <p className="callout warning" role="alert" data-testid="undeclared">
            {t('bid.clarifications.undeclared.notice')}{' '}
            {packageId === '' ? null : (
              <Link to={declarationPath(packageId)} data-testid="link-declare">
                {t('bid.clarifications.undeclared.link')}
              </Link>
            )}
          </p>
        ) : (
          <>
            {mayAsk ? (
              <StateBoundary state={proposalState} onRetry={() => void proposals.refetch()}>
                <SendPanel packageCode={packageCode} recipients={recipients} preselected={recipients.some((recipient) => recipient.proposalId === wantedProposal) ? wantedProposal : ''} />
              </StateBoundary>
            ) : null}
            {canSend(permissions, mode) && packageId === '' ? (
              <p className="callout" role="note" data-testid="choose-package">
                {t('bid.clarifications.package.hint')}
              </p>
            ) : null}
            {single ? (
              <p className="callout" role="note" data-testid="opened-request">
                {t('bid.clarifications.opened.notice')}
              </p>
            ) : null}
            <StateBoundary state={state} onRetry={() => void read.refetch()}>
              <div data-testid="requests">
                {lines.map((line) => (
                  <RequestCard
                    key={line.id}
                    line={line}
                    now={now}
                    answerable={mayAnswer(line, permissions, mode, now)}
                    document={drafts[line.id] ?? ''}
                    pending={answer.isPending && answer.variables?.line.id === line.id}
                    busy={answer.isPending && answer.variables?.line.id !== line.id}
                    refusal={answer.isError && answer.variables?.line.id === line.id ? answer.error : undefined}
                    onDocument={(value) => setDrafts((current) => withAnswerDraft(current, line.id, value))}
                    onAnswer={() => send(line)}
                  />
                ))}
              </div>
            </StateBoundary>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.clarifications.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
