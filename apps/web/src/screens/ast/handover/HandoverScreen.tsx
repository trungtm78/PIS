import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink } from '../../ctr/components';
import { useTrace } from './hooks';
import { documentRoleLabel, kindLabel, punchStatusLabel, severityLabel, statusLabel } from './labels';
import { openCritical } from './model';
import type { PunchItem, Trace } from './model';
import { DecisionDialog, FixDialog, ItemDialog, VerifyDialog, WaiveDialog } from './HandoverDialogs';
import '../../qms/qms.css';

type Dialog = { kind: 'item' } | { kind: 'decide' } | { kind: 'fix'; item: PunchItem } | { kind: 'verify'; item: PunchItem } | { kind: 'waive'; item: PunchItem };

/**
 * AST-02: the minutes of a handover and its punch list (ST-AST-001, AST 3.1, BR-AST-01). The page shows the handover, the unit that receives the work, the minutes it rests on, the items still to be
 * put right with their severity, day and contractor, the assets the handover produced and the decision. A critical item that is still open is said in words on top, and the receiving unit is
 * offered to accept only when the server says it may; a critical item is never offered a waiver. The server judges every command again.
 */
export default function HandoverScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The trace and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <HandoverContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HandoverContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [search] = useSearchParams();
  const handoverId = search.get('id');
  const trace = useTrace(handoverId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: trace.isLoading, error: trace.error, data: handoverId === null ? null : trace.data, isEmpty: (data) => data === null || data === undefined });
  const close = (): void => setDialog(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to="/ast/ast-01">{t('ast.handover.back.list')}</BackLink>
      {handoverId === null ? (
        <>
          <div className="heading">
            <div>
              <h1 id="screen-title">{t('ast.handover.review.title')}</h1>
              <p>{t('ast.handover.review.subtitle')}</p>
            </div>
          </div>
          <p className="callout" role="status" data-testid="no-handover">
            {t('ast.handover.review.none')} <Link to="/ast/ast-01">{t('ast.handover.review.none.link')}</Link>
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void trace.refetch()}>
          {trace.data === null || trace.data === undefined ? null : <Review trace={trace.data} readOnly={mode === 'READ_ONLY'} onOpen={setDialog} />}
        </StateBoundary>
      )}
      {dialog === undefined || trace.data === null || trace.data === undefined ? null : dialog.kind === 'item' ? (
        <ItemDialog handover={trace.data.handover} onClose={close} />
      ) : dialog.kind === 'decide' ? (
        <DecisionDialog handover={trace.data.handover} onClose={close} />
      ) : dialog.kind === 'fix' ? (
        <FixDialog handover={trace.data.handover} item={dialog.item} onClose={close} />
      ) : dialog.kind === 'verify' ? (
        <VerifyDialog handover={trace.data.handover} item={dialog.item} onClose={close} />
      ) : (
        <WaiveDialog handover={trace.data.handover} item={dialog.item} onClose={close} />
      )}
      <p className="prototype-note">{t('ast.handover.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Review({ trace, readOnly, onOpen }: { trace: Trace; readOnly: boolean; onOpen(dialog: Dialog): void }) {
  const { t, locale } = useTranslation();
  const { handover, items } = trace;
  const critical = openCritical(items);
  const decidable = !readOnly && (handover.allowed.approve || handover.allowed.return || handover.allowed.reject);
  const day = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const missingAsBuilt = handover.status !== 'ACCEPTED' && handover.status !== 'REJECTED' && handover.asBuiltDocumentVersionId === null;

  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.handover.review.title')}</h1>
          <p>
            <strong data-testid="handover-no">{handover.handoverNo}</strong> · {handover.contract.code} · {kindLabel(t, handover.kind)}{' '}
            <span className={handover.status === 'ACCEPTED' ? 'qms-badge ok' : handover.status === 'REJECTED' ? 'qms-badge danger' : 'qms-badge'} data-testid="status">
              {statusLabel(t, handover.status)}
            </span>
          </p>
          <p className="sub" data-testid="receiving-unit">
            {t('ast.handover.receiving.label', { unit: handover.recipientUnit.name })}
          </p>
        </div>
        {readOnly ? null : (
          <div className="actions" data-testid="commands">
            {handover.allowed.addItem ? (
              <button type="button" data-command="add-item" onClick={() => onOpen({ kind: 'item' })}>
                {t('ast.handover.item.action')}
              </button>
            ) : null}
            {decidable ? (
              <button type="button" className="primary" data-command="decide" onClick={() => onOpen({ kind: 'decide' })}>
                {t('ast.handover.decide.action')}
              </button>
            ) : null}
          </div>
        )}
      </div>
      <div className="card" data-testid="notices">
        {critical.length > 0 ? (
          <p className="callout warning" role="status" data-testid="critical-notice">
            {t('ast.handover.critical.notice', { count: critical.length })}
          </p>
        ) : null}
        {missingAsBuilt ? (
          <p className="callout warning" role="status" data-testid="as-built-notice">
            {t('ast.handover.asBuilt.missing')}
          </p>
        ) : null}
        {handover.status === 'REJECTED' && handover.rejectionReason !== null ? (
          <p className="callout" role="status" data-testid="rejection">
            {t('ast.handover.rejection.label', { reason: handover.rejectionReason })}
          </p>
        ) : null}
        {handover.decisionNote !== null && handover.status !== 'REJECTED' ? (
          <p className="callout" role="status" data-testid="decision-note">
            {t('ast.handover.decisionNote.label', { note: handover.decisionNote })}
          </p>
        ) : null}
      </div>
      <div className="card">
        {items.length === 0 ? (
          <p className="callout" role="status" data-testid="no-items">
            {t('ast.handover.items.none')}
          </p>
        ) : (
          <table className="table" data-testid="items">
            <thead>
              <tr>
                <th scope="col">{t('ast.handover.column.item')}</th>
                <th scope="col">{t('ast.handover.column.severity')}</th>
                <th scope="col">{t('ast.handover.column.contractor')}</th>
                <th scope="col">{t('ast.handover.column.due')}</th>
                <th scope="col">{t('ast.handover.column.state')}</th>
                <th scope="col">
                  <span className="sr-only">{t('ast.handover.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-item={item.id} data-status={item.status} data-severity={item.severity}>
                  <td>
                    <strong data-testid="item-no">{item.itemNo}</strong> <span data-testid="description">{item.description}</span>
                    {item.locationText === null ? null : <small className="sub qms-regime">{item.locationText}</small>}
                    {item.fixedNote !== null && item.status !== 'OPEN' ? <small className="sub qms-regime">{t('ast.handover.fixed.note', { note: item.fixedNote })}</small> : null}
                    {item.verificationNote !== null ? <small className="sub qms-regime">{t('ast.handover.verification.note', { note: item.verificationNote })}</small> : null}
                    {item.waiverReason === null ? null : (
                      <small className="sub qms-regime" data-testid="waiver">
                        {t('ast.handover.waiver.note', { reason: item.waiverReason })}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className={item.severity === 'CRITICAL' ? 'qms-badge danger' : item.severity === 'MAJOR' ? 'qms-badge warning' : 'qms-badge'} data-testid="severity">
                      {severityLabel(t, item.severity)}
                    </span>
                  </td>
                  <td data-testid="contractor">{item.contractor === null ? t('ast.handover.contractor.none') : item.contractor.name}</td>
                  <td data-testid="due">
                    {day(item.dueOn)}
                    {item.overdue ? (
                      <>
                        {' '}
                        <span className="qms-badge warning" data-testid="overdue" role="status">
                          {t('ast.handover.overdue.badge')}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <span className="qms-badge" data-testid="item-status">
                      {punchStatusLabel(t, item.status)}
                    </span>
                    {item.reopenCount > 0 ? <small className="sub qms-regime">{t('ast.handover.reopened.count', { count: item.reopenCount })}</small> : null}
                  </td>
                  <td>
                    {readOnly ? null : (
                      <>
                        {item.allowed.fix ? (
                          <button type="button" data-fix={item.id} onClick={() => onOpen({ kind: 'fix', item })}>
                            {t('ast.handover.fix.action')}
                          </button>
                        ) : null}
                        {item.allowed.verify ? (
                          <button type="button" data-verify={item.id} onClick={() => onOpen({ kind: 'verify', item })}>
                            {t('ast.handover.verify.action')}
                          </button>
                        ) : null}
                        {item.allowed.waive ? (
                          <button type="button" data-waive={item.id} onClick={() => onOpen({ kind: 'waive', item })}>
                            {t('ast.handover.waive.action')}
                          </button>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>{t('ast.handover.documents.title')}</h2>
        <ul data-testid="documents">
          {trace.documents.map((document) => (
            <li key={document.role} data-role={document.role}>
              {documentRoleLabel(t, document.role)}: <code>{document.documentVersionId}</code>
            </li>
          ))}
          {trace.qualityAcceptance === null ? null : <li data-testid="minutes">{t('ast.handover.minutes.label', { recordNo: trace.qualityAcceptance.recordNo })}</li>}
        </ul>
      </div>
      <div className="card">
        <h2>{t('ast.handover.assets.title')}</h2>
        {trace.assets.length === 0 ? (
          <p className="sub" data-testid="no-assets">
            {t('ast.handover.assets.none')}
          </p>
        ) : (
          <ul data-testid="assets">
            {trace.assets.map((asset) => (
              <li key={asset.id} data-asset={asset.id}>
                {asset.assetCode}
                {asset.name === null ? '' : ` · ${asset.name}`} · {asset.valueVnd}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
