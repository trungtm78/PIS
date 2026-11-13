import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { holds } from '../../../session/holds';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { useInspections } from '../inspection/hooks';
import { roleLabel, typeLabel } from '../inspection/labels';
import { DecideDialog, DraftDialog, RevokeDialog, SignDialog } from './AcceptanceDialogs';
import { useAcceptances } from './hooks';
import { effectLabel, methodLabel, scopeLabel, statusLabel } from './labels';
import { canDraft, draftable } from './model';
import type { AcceptanceLine } from './model';
import '../qms.css';
import { ScrollRegion } from '../../scroll-region';

/**
 * QMS-05: quality acceptance minutes (ST-QMS-005, QMS 3.2, BR-QMS-02, BR-QMS-03, BR-QMS-05). The supervisor drafts minutes from an inspection that passed; each role the regime of the
 * day required of the inspection signs them (the contractor as the contractor, the staff for the side of the procuring entity) over one hash of what they say; and someone other than whoever
 * drafted them approves them once every role has signed and no serious non-conformance of the contract is open. An in-app confirmation is shown as an internal record, never as a digital
 * signature. The server judges every command again.
 */
export default function AcceptanceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The minutes and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <AcceptanceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

/** The rights of the commands on the minutes (openapi `x-permission`): the server says what each minute allows, the session what the person holds. */
const SIGN_PERMISSION = 'qacceptance.sign';
const APPROVE_PERMISSION = 'qacceptance.approve';
const REVOKE_PERMISSION = 'qacceptance.revoke';

/** The roles of the minutes that hold a valid signature. */
const signedCount = (line: AcceptanceLine): number => line.requiredRoles.filter((role) => line.signatures.some((signature) => signature.role === role && signature.valid)).length;

type Dialog = { kind: 'draft' } | { kind: 'sign'; line: AcceptanceLine } | { kind: 'decide'; line: AcceptanceLine } | { kind: 'revoke'; line: AcceptanceLine };

function AcceptanceContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contracts = useContracts();
  // Whoever may read the minutes and not the register still reads them: only the filter is missing.
  const options = useMemo(() => contracts.data ?? [], [contracts.data]);
  const wanted = search.get('contract') ?? '';
  const contractId = options.some((contract) => contract.id === wanted) ? wanted : '';
  const acceptances = useAcceptances(contractId);
  // The inspections the minutes can be drafted from; whoever may not read them is not offered the drafting.
  const inspections = useInspections(contractId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  // A tenant with no minutes is not an empty screen: the supervisor still drafts the first.
  const state = useScreenState({ isLoading: acceptances.isLoading, error: acceptances.error, data: acceptances.data, isEmpty: () => false });
  const lines = useMemo(() => acceptances.data ?? [], [acceptances.data]);
  const candidates = useMemo(() => draftable(inspections.data ?? [], lines), [inspections.data, lines]);
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const choose = (id: string): void => setSearch(id === '' ? {} : { contract: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.acceptance.page.title')}</h1>
          <p>{t('qms.acceptance.page.subtitle')}</p>
        </div>
        {canDraft(permissions, mode) && candidates.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'draft' })}>
              {t('qms.acceptance.draft.action')}
            </button>
          </div>
        ) : null}
      </div>
      {options.length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="acceptances-contract">{t('qms.acceptance.filter.contract')}</label>
            <select id="acceptances-contract" value={contractId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('qms.acceptance.filter.all')}</option>
              {options.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void acceptances.refetch()}>
        <div className="card">
          <ScrollRegion label={t('qms.acceptance.page.title')}>
            {/* The table names itself the list only once it holds a line: until then the columns stand over the empty notice, and nothing waits on a list that is not there yet. */}
            <table className="table" data-testid={lines.length === 0 ? undefined : 'acceptances'}>
              <thead>
                <tr>
                  <th scope="col">{t('qms.acceptance.column.record')}</th>
                  <th scope="col">{t('qms.acceptance.column.scope')}</th>
                  <th scope="col">{t('qms.acceptance.column.signatures')}</th>
                  <th scope="col">{t('scr2.qms.acceptance.column.signed')}</th>
                  <th scope="col">{t('scr2.qms.acceptance.column.ncr')}</th>
                  <th scope="col">{t('qms.acceptance.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('qms.acceptance.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={7} role="status" data-testid="no-acceptances">
                      {t('qms.acceptance.none.notice')}
                    </td>
                  </tr>
                ) : null}
                {lines.map((line) => (
                  <tr key={line.id} data-acceptance={line.id} data-status={line.status}>
                    <td data-testid="record">
                      <strong>{line.recordNo}</strong>
                      <small className="sub qms-regime">
                        {line.contract.code} · {line.inspection.inspectionNo} · {typeLabel(t, line.inspection.inspectionType)}
                        {line.boqItemKey === null ? '' : ` · ${line.boqItemKey}`}
                      </small>
                      {line.regime.awaitingConfirmation ? (
                        <span className="qms-badge warning" data-testid="regime-warning" role="status">
                          {t('qms.acceptance.regime.unconfirmed', { cxn: line.regime.cxn ?? '' })}
                        </span>
                      ) : null}
                    </td>
                    <td data-testid="scope">{scopeLabel(t, line.acceptanceScope)}</td>
                    <td>
                      <ul className="qms-signers" data-testid="signers">
                        {line.requiredRoles.map((role) => {
                          const signature = line.signatures.find((candidate) => candidate.role === role);
                          return (
                            <li key={role} data-role={role} data-signed={signature !== undefined && signature.valid ? 'true' : 'false'}>
                              <strong>{roleLabel(t, role)}</strong>
                              {signature === undefined ? (
                                <span className="sub"> — {t('qms.acceptance.signer.waiting')}</span>
                              ) : (
                                <span className="sub">
                                  {' '}
                                  — {signature.signerName}, {moment(signature.signedAt)} · {methodLabel(t, signature.method)} · <span data-testid="effect">{effectLabel(t, signature.legalEffect)}</span>
                                  {signature.certSerial === null ? '' : ` · ${signature.certSerial}`}
                                  {signature.valid ? '' : <span className="qms-badge danger">{t('qms.acceptance.signer.void')}</span>}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                    <td data-testid="signed">{t('scr2.qms.acceptance.signed.value', { signed: signedCount(line), required: line.requiredRoles.length })}</td>
                    <td data-testid="ncr">
                      {line.openCriticalNcr > 0 && (line.status === 'DRAFT' || line.status === 'SIGNING') ? (
                        <span className="qms-badge danger" data-testid="ncr-open" role="status">
                          {t('qms.acceptance.ncr.open', { count: line.openCriticalNcr })}
                        </span>
                      ) : (
                        line.openCriticalNcr
                      )}
                    </td>
                    <td>
                      <span className={line.status === 'APPROVED' ? 'qms-badge ok' : line.status === 'REJECTED' || line.status === 'REVOKED' ? 'qms-badge danger' : 'qms-badge'} data-testid="status">
                        {statusLabel(t, line.status)}
                      </span>
                      {line.decisionNote === null ? null : (
                        <small className="sub qms-regime" data-testid="decision-note">
                          {line.decisionNote}
                        </small>
                      )}
                      {line.revokeReason === null ? null : (
                        <small className="sub qms-regime" data-testid="revoke-reason">
                          {t('qms.acceptance.revoked.reason', { reason: line.revokeReason })}
                        </small>
                      )}
                    </td>
                    <td>
                      {mode === 'READ_ONLY' ? null : (
                        <>
                          {line.canSign && holds(permissions, SIGN_PERMISSION) ? (
                            <button type="button" data-sign={line.id} onClick={() => setDialog({ kind: 'sign', line })}>
                              {t('qms.acceptance.sign.action')}
                            </button>
                          ) : null}
                          {(line.canApprove || line.canReject) && holds(permissions, APPROVE_PERMISSION) ? (
                            <button type="button" data-decide={line.id} onClick={() => setDialog({ kind: 'decide', line })}>
                              {t('qms.acceptance.decide.action')}
                            </button>
                          ) : null}
                          {line.canRevoke && holds(permissions, REVOKE_PERMISSION) ? (
                            <button type="button" data-revoke={line.id} onClick={() => setDialog({ kind: 'revoke', line })}>
                              {t('qms.acceptance.revoke.action')}
                            </button>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </div>
      </StateBoundary>
      {dialog?.kind === 'draft' ? <DraftDialog inspections={candidates} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'sign' ? <SignDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'decide' ? <DecideDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'revoke' ? <RevokeDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('qms.acceptance.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
