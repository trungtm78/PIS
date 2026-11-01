import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { canAct, vietnamToday } from '../diary/model';
import type { DiaryLine } from '../diary/model';
import '../qms.css';
import { ComposePanel } from './ComposePanel';
import { QueuePanel } from './QueuePanel';
import { ServerPanel } from './ServerPanel';
import { useOfflineContracts, useOfflineQueue } from './hooks';
import { CONTRACT_PERMISSION, READ_PERMISSION, WRITE_PERMISSION, draftOver, holds, newDraft, queueItem } from './model';
import type { Draft } from './model';
import type { Persisted } from './store';

/**
 * QMS-09: the site diary written on a phone or a laptop with no connection (ST-QMS-002, QMS 3.1). A diary is kept on the device with its own operation id until the send, so that a diary delivered twice is one diary
 * (UAT-AC358); when two devices wrote the same day the server keeps both and the conflict is shown and settled by a person (UAT-AC62), never written over; the place is kept only with the consent of the person
 * (UAT-AC367), and what the device kept for another tenant is removed when this one opens. Signing and settling go straight to the server: no signature waits in the queue.
 */
export default function OfflineDiaryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The queue and the form belong to one membership of one tenant: a switch of either starts the screen over.
  return <OfflineContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OfflineContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const today = vietnamToday();
  const queue = useOfflineQueue();
  const writable = canAct(mode) && holds(permissions, WRITE_PERMISSION);
  const contracts = useOfflineContracts(writable && holds(permissions, CONTRACT_PERMISSION));
  const [start, setStart] = useState<Draft>(() => newDraft(today));
  const [round, setRound] = useState(0);
  // What the composer starts from changes with each beginning: a diary of the server chosen to write over, the form started over, the work dropped.
  const beginning = useRef(0);
  const begin = (next: Draft): void => {
    beginning.current += 1;
    setStart(next);
    setRound((current) => current + 1);
  };
  const codeOf = (contractId: string): string => contracts.find((contract) => contract.id === contractId)?.code ?? '';

  // The diary is queued from the form as it was when it was sent. The composer starts over only if it is still that form: whatever the person edited, or the diary of the server chosen, while the device was taking the diary
  // in is not lost (the diary that was sent is in the queue all the same).
  const onQueue = async (draft: Draft, unchanged: () => boolean): Promise<Persisted> => {
    const sentAt = beginning.current;
    const kept = await queue.enqueue(
      queueItem({
        form: draft.form,
        contractCode: codeOf(draft.form.contractId),
        base: draft.base,
        baseServerVersion: draft.baseServerVersion,
        place: draft.place,
        clientOperationId: globalThis.crypto.randomUUID(),
        now: new Date(),
      }),
    );
    if (kept === 'ok') {
      if (beginning.current === sentAt && unchanged()) begin(newDraft(today));
      void queue.flush();
    }
    return kept;
  };
  const onWrite = (line: DiaryLine): void => begin(draftOver(line));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.offline.page.title')}</h1>
          <p>{t('qms.offline.page.subtitle')}</p>
        </div>
      </div>
      {writable ? (
        <ComposePanel key={round} contracts={contracts} today={today} start={start} onQueue={onQueue} onCancelEdit={() => begin(newDraft(today))} />
      ) : (
        <p className="callout warning" role="status" data-testid="cannot-write">
          {mode === 'READ_ONLY' ? t('qms.offline.frozen.notice') : t('qms.offline.denied.notice')}
        </p>
      )}
      <QueuePanel queue={queue} />
      {holds(permissions, READ_PERMISSION) ? <ServerPanel permissions={permissions} mode={mode} online={queue.online} onWrite={onWrite} /> : <StateBoundary state="denied" />}
      <p className="prototype-note">{t('qms.offline.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
