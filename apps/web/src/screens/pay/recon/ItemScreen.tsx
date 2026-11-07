import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Fact } from '../../ctr/components';
import { paymentLink } from '../payment/model';
import { instantText } from '../model';
import { AssignDialog, ResolveDialog } from './ReconDialogs';
import { useItem, useMembers } from './hooks';
import { itemStatusLabel, kindLabel, resolutionLabel } from './labels';
import { ASSIGN_PERMISSION, MEMBER_READ_PERMISSION, READ_PERMISSION, RESOLVE_PERMISSION, boardLink, differenceText, vndText } from './model';
import type { Resolution } from './model';
import '../pay.css';
import { SectionCard } from '../../../ui';

type Dialog = { kind: 'assign' } | { kind: 'resolve'; resolution: Resolution };

/**
 * PAY-06: the work on one difference (ST-PAY-007, PAY 3.3 step 5). The two figures it was opened with and the difference between them are shown and never edited; the item has an owner and a
 * day it is due; it is explained first, then resolved, or written off by someone other than the owner with the document that approves it. Each command is offered only where the state of the item
 * allows it and the caller holds its permission; the server judges both again.
 */
export default function ItemScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The item and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ItemContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ItemContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const [search] = useSearchParams();
  const id = search.get('item');
  const mayRead = holds(READ_PERMISSION);
  const item = useItem(id, mayRead);
  const people = useMembers(holds(ASSIGN_PERMISSION) && holds(MEMBER_READ_PERMISSION));
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const state = useScreenState({
    isLoading: item.isLoading,
    error: item.error,
    data: id === null ? null : item.data,
    isEmpty: (data) => data === null || data === undefined,
  });
  const row = item.data;
  const writable = mode !== 'READ_ONLY';
  const finished = (message: string) => (): void => {
    setDone(message);
    setDialog(undefined);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={boardLink()}>{t('pay.item.back')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.item.title')}</h1>
          <p>{t('pay.item.subtitle')}</p>
        </div>
      </div>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {id === null ? (
        <p className="callout" role="status" data-testid="no-item">
          {t('pay.item.none')}
        </p>
      ) : !mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.recon.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void item.refetch()}>
          {row === null || row === undefined ? null : (
            <SectionCard title={t('pay.item.title')}>
              <h2>
                <span data-testid="kind">{kindLabel(t, row.kind)}</span>{' '}
                <span className="pay-badge" data-testid="status">
                  {itemStatusLabel(t, row.status)}
                </span>
                {row.overdue ? (
                  <>
                    {' '}
                    <span className="pay-badge warning" data-testid="overdue">
                      {t('pay.recon.overdue')}
                    </span>
                  </>
                ) : null}
              </h2>
              <dl className="pay-facts">
                <Fact label={t('pay.item.fact.project')}>
                  <span data-testid="project">{row.projectCode}</span>
                </Fact>
                {row.contractCode === null ? null : (
                  <Fact label={t('pay.item.fact.contract')}>
                    <span data-testid="contract">{row.contractCode}</span>
                  </Fact>
                )}
                {row.paymentRequestId === null ? null : (
                  <Fact label={t('pay.item.fact.request')}>
                    <Link to={paymentLink(row.paymentRequestId)} data-testid="request">
                      {row.requestNo ?? row.paymentRequestId}
                    </Link>
                  </Fact>
                )}
                {row.documentNo === null ? null : (
                  <Fact label={t('pay.item.fact.voucher')}>
                    <span data-testid="voucher">{row.documentNo}</span>
                  </Fact>
                )}
                {row.sourceFileName === null ? null : (
                  <Fact label={t('pay.item.fact.source')}>
                    <span data-testid="file">{row.sourceFileName}</span>
                    {row.sourceFileSha256 === null ? null : (
                      <span className="pay-key" data-testid="hash">
                        {' '}
                        {row.sourceFileSha256}
                      </span>
                    )}
                  </Fact>
                )}
                <Fact label={t('pay.item.fact.internal')}>
                  <strong data-testid="internal">{row.internalVnd === null ? '' : vndText(row.internalVnd, locale)}</strong>
                </Fact>
                <Fact label={t('pay.item.fact.confirmed')}>
                  <strong data-testid="confirmed">{row.confirmedVnd === null ? '' : vndText(row.confirmedVnd, locale)}</strong>
                </Fact>
                <Fact label={t('pay.item.fact.difference')}>
                  <strong data-testid="difference">{row.differenceVnd === null ? '' : differenceText(row.differenceVnd, locale)}</strong>
                </Fact>
                <Fact label={t('pay.item.fact.owner')}>
                  <span data-testid="owner">{row.ownerName ?? row.ownerMembershipId}</span>
                </Fact>
                <Fact label={t('pay.item.fact.due')}>
                  <span data-testid="due">{instantText(row.dueAt, locale)}</span>
                </Fact>
                {row.resolutionNote === null ? null : (
                  <Fact label={t('pay.item.fact.note')}>
                    <span data-testid="note">{row.resolutionNote}</span>
                  </Fact>
                )}
                {row.resolvedAt === null ? null : (
                  <Fact label={t('pay.item.fact.resolvedAt')}>
                    <span data-testid="resolved-at">{instantText(row.resolvedAt, locale)}</span>
                  </Fact>
                )}
                {row.approvalDocumentVersionId === null ? null : (
                  <Fact label={t('pay.item.fact.approval')}>
                    <span className="pay-key" data-testid="approval">
                      {row.approvalDocumentVersionId}
                    </span>
                  </Fact>
                )}
                {row.issueId === null ? null : (
                  <Fact label={t('pay.item.fact.issue')}>
                    <span className="pay-key" data-testid="issue">
                      {row.issueId}
                    </span>
                  </Fact>
                )}
              </dl>
              <p className="sub" data-testid="keeps">
                {t('pay.item.keeps')}
              </p>
              {writable ? (
                <div className="pay-row-actions">
                  {row.actions.assign && holds(ASSIGN_PERMISSION) ? (
                    <button type="button" data-action="assign" disabled={people.isLoading} onClick={() => setDialog({ kind: 'assign' })}>
                      {t('pay.item.action.assign')}
                    </button>
                  ) : null}
                  {row.actions.explain && holds(RESOLVE_PERMISSION) ? (
                    <button type="button" data-action="explain" onClick={() => setDialog({ kind: 'resolve', resolution: 'EXPLAINED' })}>
                      {resolutionLabel(t, 'EXPLAINED')}
                    </button>
                  ) : null}
                  {row.actions.resolve && holds(RESOLVE_PERMISSION) ? (
                    <button type="button" data-action="resolve" onClick={() => setDialog({ kind: 'resolve', resolution: 'RESOLVED' })}>
                      {resolutionLabel(t, 'RESOLVED')}
                    </button>
                  ) : null}
                  {row.actions.writeOff && holds(RESOLVE_PERMISSION) ? (
                    <button type="button" data-action="write-off" onClick={() => setDialog({ kind: 'resolve', resolution: 'WRITTEN_OFF' })}>
                      {resolutionLabel(t, 'WRITTEN_OFF')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {dialog?.kind === 'assign' ? <AssignDialog item={row} people={people.data ?? []} now={() => new Date()} onDone={finished(t('pay.item.done.assigned'))} onClose={() => setDialog(undefined)} /> : null}
              {dialog?.kind === 'resolve' ? (
                <ResolveDialog
                  item={row}
                  resolution={dialog.resolution}
                  onDone={finished(dialog.resolution === 'EXPLAINED' ? t('pay.item.done.explained') : dialog.resolution === 'RESOLVED' ? t('pay.item.done.resolved') : t('pay.item.done.writtenOff'))}
                  onClose={() => setDialog(undefined)}
                />
              ) : null}
            </SectionCard>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.item.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
