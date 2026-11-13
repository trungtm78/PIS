import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { holds } from '../../../session/holds';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { useInspections } from './hooks';
import { outcomeLabel, resultLabel, roleLabel, statusLabel, typeLabel } from './labels';
import { canRequest } from './model';
import type { InspectionLine } from './model';
import { CancelDialog, RequestDialog, ResultDialog, ScheduleDialog } from './InspectionDialogs';
import '../qms.css';
import { ScrollRegion } from '../../scroll-region';
import { reviewLink } from '../diary/model';

/**
 * QMS-04: ask for an inspection of work under a contract and follow it to its result (ST-QMS-004, QMS 3.2, BR-QMS-04). A contractor (a guest, in its own contract) or the supervisor
 * asks for an inspection of work on a contract that is being performed; the regime in force on the day it is asked for gives the checklist and the roles that sign the minutes, and the
 * screen warns while the rule data of that regime waits for its confirmation. The supervisor schedules it with the people who take part and records the result against the checklist.
 * The server judges every command again: the state of the contract, the permits of the start of construction, the regime and the checklist.
 */
export default function InspectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The inspections and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <InspectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

/** The rights of the commands on a request (openapi `x-permission`): schedule and cancel, record the result. */
const MANAGE_PERMISSION = 'inspection.manage';
const RECORD_PERMISSION = 'inspection.record';
const NONE = '—';

type Dialog = { kind: 'request' } | { kind: 'schedule'; line: InspectionLine } | { kind: 'record'; line: InspectionLine } | { kind: 'cancel'; line: InspectionLine };

function InspectionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contracts = useContracts();
  // Whoever may read inspections and not the register still reads them: only the filter and the choice of a contract are missing.
  const options = useMemo(() => contracts.data ?? [], [contracts.data]);
  const wanted = search.get('contract') ?? '';
  const contractId = options.some((contract) => contract.id === wanted) ? wanted : '';
  const inspections = useInspections(contractId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  // A tenant with no inspection is not an empty screen: the contractor still asks for the first.
  const state = useScreenState({ isLoading: inspections.isLoading, error: inspections.error, data: inspections.data, isEmpty: () => false });
  const lines = inspections.data ?? [];
  const active = useMemo(() => options.filter((contract) => contract.status === 'ACTIVE'), [options]);
  const day = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  // The server says what each request allows the membership; the session says what the person holds.
  const mayManage = holds(permissions, MANAGE_PERMISSION);
  const mayRecord = holds(permissions, RECORD_PERMISSION);
  const choose = (id: string): void => setSearch(id === '' ? {} : { contract: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.inspection.page.title')}</h1>
          <p>{t('qms.inspection.page.subtitle')}</p>
        </div>
        {canRequest(permissions, mode) && active.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'request' })}>
              {t('qms.inspection.request.action')}
            </button>
          </div>
        ) : null}
      </div>
      {options.length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="inspections-contract">{t('qms.inspection.filter.contract')}</label>
            <select id="inspections-contract" value={contractId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('qms.inspection.filter.all')}</option>
              {options.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void inspections.refetch()}>
        <div className="card">
          <ScrollRegion label={t('qms.inspection.page.title')}>
            <table className="table" data-testid="inspections">
              <thead>
                <tr>
                  <th scope="col">{t('qms.inspection.column.no')}</th>
                  <th scope="col">{t('qms.inspection.field.contract')}</th>
                  <th scope="col">{t('qms.inspection.field.item')}</th>
                  <th scope="col">{t('qms.inspection.field.type')}</th>
                  <th scope="col">{t('qms.inspection.column.inspection')}</th>
                  <th scope="col">{t('qms.inspection.field.location')}</th>
                  <th scope="col">{t('qms.inspection.column.day')}</th>
                  <th scope="col">{t('qms.inspection.field.diary')}</th>
                  <th scope="col">{t('qms.inspection.column.regime')}</th>
                  <th scope="col">{t('qms.inspection.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('qms.inspection.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={11} role="status" data-testid="no-inspections">
                      {t('qms.inspection.none.notice')}
                    </td>
                  </tr>
                ) : null}
                {lines.map((line) => (
                  <tr key={line.id} data-inspection={line.id} data-status={line.status}>
                    <td data-testid="no">{line.inspectionNo}</td>
                    <td data-testid="contract">{line.contract.code}</td>
                    <td data-testid="boq">{line.boqItem === null ? NONE : line.boqItem.businessKey}</td>
                    <td data-testid="type">{typeLabel(t, line.inspectionType)}</td>
                    <td data-testid="inspection">
                      <strong>{line.title}</strong>
                      {line.status === 'CANCELLED' && line.cancelReason !== null ? (
                        <small className="sub qms-regime" data-testid="cancel-reason">
                          {t('qms.inspection.cancelled.reason', { reason: line.cancelReason })}
                        </small>
                      ) : null}
                      {line.status === 'RESULT_RECORDED' ? (
                        <details data-testid="checklist">
                          <summary>{t('qms.inspection.checklist.summary', { count: line.checklist.length })}</summary>
                          <ul className="qms-checklist">
                            {line.checklist.map((item) => (
                              <li key={item.code} data-item={item.code}>
                                {item.label} — {item.outcome === null ? '' : outcomeLabel(t, item.outcome)}
                                {item.note === null ? '' : ` (${item.note})`}
                              </li>
                            ))}
                          </ul>
                          {line.resultNote === null ? null : <p className="sub">{line.resultNote}</p>}
                        </details>
                      ) : null}
                    </td>
                    <td data-testid="location">{line.locationText ?? NONE}</td>
                    <td data-testid="day">
                      {day(line.requestedFor)}
                      {line.scheduledAt === null ? null : (
                        <small className="sub qms-regime" data-testid="scheduled">
                          {t('qms.inspection.scheduled.at', { at: moment(line.scheduledAt) })}
                        </small>
                      )}
                    </td>
                    <td data-testid="diary">{line.siteDiaryId === null ? NONE : <Link to={reviewLink(line.siteDiaryId)}>{t('scr2.qms.inspection.diary.open')}</Link>}</td>
                    <td data-testid="regime">
                      {line.regime.label ?? t('qms.inspection.regime.unknown')}
                      {line.regime.legalBasis === null ? null : <small className="sub qms-regime">{line.regime.legalBasis}</small>}
                      <small className="sub qms-regime" data-testid="roles">
                        {t('qms.inspection.roles.label', { roles: line.requiredRoles.map((role) => roleLabel(t, role)).join(', ') })}
                      </small>
                      {line.regime.awaitingConfirmation ? (
                        <span className="qms-badge warning" data-testid="regime-warning" role="status">
                          {t('qms.inspection.regime.unconfirmed', { cxn: line.regime.cxn ?? '' })}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className={line.status === 'RESULT_RECORDED' && line.result === 'PASS' ? 'qms-badge ok' : line.status === 'RESULT_RECORDED' && line.result !== 'PASS' ? 'qms-badge danger' : 'qms-badge'} data-testid="status">
                        {statusLabel(t, line.status)}
                      </span>
                      {line.result === null ? null : (
                        <small className="sub qms-regime" data-testid="result">
                          {resultLabel(t, line.result)}
                        </small>
                      )}
                    </td>
                    <td>
                      {mode === 'READ_ONLY' ? null : (
                        <>
                          {line.canSchedule && mayManage ? (
                            <button type="button" data-schedule={line.id} onClick={() => setDialog({ kind: 'schedule', line })}>
                              {t('qms.inspection.schedule.action')}
                            </button>
                          ) : null}
                          {line.canRecord && mayRecord ? (
                            <button type="button" data-record={line.id} onClick={() => setDialog({ kind: 'record', line })}>
                              {t('qms.inspection.record.action')}
                            </button>
                          ) : null}
                          {line.canCancel && mayManage ? (
                            <button type="button" data-cancel={line.id} onClick={() => setDialog({ kind: 'cancel', line })}>
                              {t('qms.inspection.cancel.action')}
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
      {dialog?.kind === 'request' ? <RequestDialog contracts={active} initialContractId={contractId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'schedule' ? <ScheduleDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'record' ? <ResultDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('qms.inspection.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
