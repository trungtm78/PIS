import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ResolveDialog, SignDialog } from '../diary/DiaryDialogs';
import { ConflictPanel, DiaryTitle } from '../diary/DiaryParts';
import { useDiaries } from '../diary/hooks';
import { NO_FILTER, canAct, pendingConflicts } from '../diary/model';
import type { DiaryLine } from '../diary/model';
import '../qms.css';
import { SIGN_PERMISSION, WRITE_PERMISSION, holds } from './model';

type Dialog = { kind: 'resolve' | 'sign'; id: string };
type DiaryQuery = ReturnType<typeof useDiaries>;

const CONFLICTS = { ...NO_FILTER, hasConflict: true };
const DRAFTS = { ...NO_FILTER, status: 'DRAFT' };

/**
 * The diaries on the server that the device has to do with: those with a copy that a device left and nobody has settled (the conflicts, which the server stored and nothing overwrote), and the drafts, which the
 * contractor signs or writes over on the device. Settling a conflict and signing are commands that are sent at once and never queued: a signature kept for later would be a signature nobody asked for.
 */
export function ServerPanel({
  permissions,
  mode,
  online,
  onWrite,
}: {
  permissions: readonly string[] | undefined;
  mode: 'FULL' | 'READ_ONLY' | undefined;
  online: boolean;
  onWrite(line: DiaryLine): void;
}) {
  const { t } = useTranslation();
  const conflicts = useDiaries(CONFLICTS);
  const drafts = useDiaries(DRAFTS);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const lines = useMemo(() => {
    const all = [...(conflicts.data?.pages ?? []), ...(drafts.data?.pages ?? [])].flatMap((page) => page.lines);
    return all.filter((line, index) => all.findIndex((other) => other.id === line.id) === index);
  }, [conflicts.data, drafts.data]);
  const loaded = useScreenState({
    isLoading: conflicts.isLoading || drafts.isLoading,
    // A page that could not be read after others were is not the failure of the list: the diaries read stay, and the page is asked for again from a control beside them.
    error: (conflicts.isFetchNextPageError ? null : conflicts.error) ?? (drafts.isFetchNextPageError ? null : drafts.error),
    data: conflicts.data !== undefined && drafts.data !== undefined ? lines : undefined,
    isEmpty: () => lines.length === 0,
  });
  // With no connection the reads wait for it; a person who has nothing to show yet is told so, instead of being left with a spinner.
  const state = !online && loaded === 'loading' ? 'offline' : loaded;
  const chosen = dialog === undefined ? undefined : lines.find((line) => line.id === dialog.id);
  const acting = canAct(mode);
  // Settling and signing go straight to the server and are never kept for later: with no connection they are not offered, and a dialog already open is closed, so that nothing waits to be sent when the connection returns.
  const sending = acting && online;
  const mayWrite = acting && holds(permissions, WRITE_PERMISSION);
  const maySign = sending && holds(permissions, SIGN_PERMISSION);
  useEffect(() => {
    if (!sending) setDialog(undefined);
  }, [sending]);
  return (
    <section className="card" aria-label={t('qms.offline.server.title')} data-testid="server">
      <h2>{t('qms.offline.server.title')}</h2>
      <StateBoundary
        state={state}
        onRetry={() => {
          void conflicts.refetch();
          void drafts.refetch();
        }}
      >
        <ul className="qms-actions" data-testid="server-diaries">
          {lines.map((line) => {
            const waiting = pendingConflicts(line).length > 0;
            return (
              <li key={line.id} data-diary={line.id} data-conflict={waiting ? 'yes' : 'no'}>
                <DiaryTitle line={line} />
                <ConflictPanel line={line} />
                <div className="actions">
                  {waiting && line.actions.resolveConflict && sending ? (
                    <button type="button" data-resolve={line.id} onClick={() => setDialog({ kind: 'resolve', id: line.id })}>
                      {t('qms.offline.server.resolve')}
                    </button>
                  ) : null}
                  {!waiting && line.status === 'DRAFT' && line.actions.contractorSign && maySign ? (
                    <button type="button" data-sign={line.id} onClick={() => setDialog({ kind: 'sign', id: line.id })}>
                      {t('qms.offline.server.sign')}
                    </button>
                  ) : null}
                  {line.status === 'DRAFT' && line.actions.revise && mayWrite ? (
                    <button type="button" data-write={line.id} onClick={() => onWrite(line)}>
                      {t('qms.offline.server.write')}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <More query={conflicts} online={online} label={t('qms.offline.server.moreConflicts.action')} />
        <More query={drafts} online={online} label={t('qms.offline.server.moreDrafts.action')} />
      </StateBoundary>
      <MoreFailed query={conflicts} online={online} kind="conflicts" />
      <MoreFailed query={drafts} online={online} kind="drafts" />
      {chosen === undefined || dialog === undefined || !sending ? null : dialog.kind === 'resolve' ? (
        <ResolveDialog line={chosen} onClose={() => setDialog(undefined)} />
      ) : (
        <SignDialog line={chosen} kind="contractor" onClose={() => setDialog(undefined)} />
      )}
    </section>
  );
}

/** The page of a list that the server has more of, asked for from a control; while the last ask failed, the control to try again takes its place (see `MoreFailed`). */
function More({ query, online, label }: { query: Pick<DiaryQuery, 'hasNextPage' | 'isFetchingNextPage' | 'isFetchNextPageError' | 'fetchNextPage'>; online: boolean; label: string }) {
  if (query.hasNextPage !== true || query.isFetchNextPageError) return null;
  return (
    <button type="button" disabled={query.isFetchingNextPage || !online} onClick={() => void query.fetchNextPage()}>
      {label}
    </button>
  );
}

function MoreFailed({ query, online, kind }: { query: Pick<DiaryQuery, 'isFetchNextPageError' | 'isFetchingNextPage' | 'fetchNextPage'>; online: boolean; kind: 'conflicts' | 'drafts' }) {
  const { t } = useTranslation();
  if (!query.isFetchNextPageError) return null;
  return (
    <div className="callout warning" role="alert" data-testid={`more-failed-${kind}`}>
      <p>{t('qms.offline.server.moreFailed.notice')}</p>
      <button type="button" disabled={query.isFetchingNextPage || !online} onClick={() => void query.fetchNextPage()}>
        {t('qms.offline.server.moreRetry.action')}
      </button>
    </div>
  );
}
