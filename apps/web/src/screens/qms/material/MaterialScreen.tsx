import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../qms.css';
import { RegisterDialog, ResultDialog } from './MaterialDialogs';
import { useMaterialContracts, useMaterialTests } from './hooks';
import { resultLabel, severityLabel, statusLabel } from './labels';
import { MANAGE_PERMISSION, canManage } from './model';

type Dialog = { kind: 'register' } | { kind: 'result'; testId: string };

const NONE = '—';

/**
 * QMS-06: the testing of materials (ST-QMS-007, QMS 3.3, UC-QMS-03, UAT-AC362). A supervisor registers the samples taken on a contract being performed and records the result of the laboratory once, with its day, its values
 * and its report; a result that failed raises a non-conformance by itself, which the row names. Each row shows the sample, the material, the laboratory, the standard, the result, the report and the non-conformance. The server
 * judges every command again.
 */
export default function MaterialScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <MaterialContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MaterialContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const allowed = permissions === undefined || permissions.includes(MANAGE_PERMISSION);
  const may = canManage(permissions, mode);
  // A tenant that is read-only takes no command: neither a sample nor a result.
  const writable = mode !== 'READ_ONLY';
  const contracts = useMaterialContracts(allowed);
  const performed = contracts.data ?? [];
  const contractId = search.get('contract') ?? '';
  const tests = useMaterialTests(contractId, allowed);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: tests.isLoading, error: tests.error, data: tests.data, isEmpty: () => false });
  const lines = tests.data ?? [];
  // A dialog on a test names the test, not a copy of it: the test is read again from the table each time it is drawn, so that a retry sends the version the table shows now.
  const target = dialog?.kind === 'result' ? lines.find((line) => line.id === dialog.testId) : undefined;
  const open = dialog === undefined ? undefined : dialog.kind === 'register' ? dialog : target !== undefined && target.canRecord && writable ? { kind: 'result' as const, test: target } : undefined;
  const choose = (id: string): void => setSearch(id === '' ? {} : { contract: id });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.material.page.title')}</h1>
          <p>{t('qms.material.page.subtitle')}</p>
        </div>
        {may && performed.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'register' })}>
              {t('qms.material.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      {may && contracts.isError ? (
        <p className="callout warning" role="alert" data-testid="contracts-failed">
          {t('qms.material.contracts.failed')}{' '}
          <button type="button" onClick={() => void contracts.refetch()}>
            {t('qms.material.contracts.retry.action')}
          </button>
        </p>
      ) : null}
      {!allowed ? (
        <p className="callout warning" role="status" data-testid="no-right">
          {t('qms.material.noRight.notice')}
        </p>
      ) : (
        <>
          {performed.length === 0 && contractId === '' ? null : (
            <div className="card">
              <div className="field">
                <label htmlFor="material-filter">{t('qms.material.filter.contract')}</label>
                <select id="material-filter" value={contractId} onChange={(event) => choose(event.target.value)}>
                  <option value="">{t('qms.material.filter.all')}</option>
                  {contractId === '' || performed.some((contract) => contract.id === contractId) ? null : <option value={contractId}>{t('qms.material.filter.ended')}</option>}
                  {performed.map((contract) => (
                    <option key={contract.id} value={contract.id}>
                      {`${contract.code} · ${contract.title ?? ''}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <StateBoundary state={state} onRetry={() => void tests.refetch()}>
            {lines.length === 0 ? (
              <p className="callout" role="status" data-testid="empty">
                {t('qms.material.empty.notice')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table" aria-label={t('qms.material.list.aria')} data-testid="tests">
                  <thead>
                    <tr>
                      <th scope="col">{t('qms.material.col.sample')}</th>
                      <th scope="col">{t('qms.material.col.material')}</th>
                      <th scope="col">{t('qms.material.col.lab')}</th>
                      <th scope="col">{t('qms.material.col.standard')}</th>
                      <th scope="col">{t('qms.material.col.result')}</th>
                      <th scope="col">{t('qms.material.col.report')}</th>
                      <th scope="col">{t('qms.material.col.ncr')}</th>
                      <th scope="col">{t('qms.material.col.status')}</th>
                      <th scope="col">{t('qms.material.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id} data-test={line.id} data-result={line.result} data-status={line.status}>
                        <td>
                          <code>{line.sampleCode}</code> <span>{line.contract.code}</span>
                        </td>
                        <td>{line.materialKind}</td>
                        <td>{line.labName}</td>
                        <td>{line.standardRef}</td>
                        <td>
                          <span className={`pill ${line.result === 'FAIL' ? 'red' : line.result === 'PASS' ? 'green' : 'gray'}`}>{resultLabel(t, line.result)}</span>
                          {line.testedOn === null ? null : <span> {line.testedOn}</span>}
                        </td>
                        <td data-testid="report">{line.reportId ?? NONE}</td>
                        <td data-testid="ncr">
                          {line.nonconformance === null ? (
                            NONE
                          ) : (
                            <>
                              <code>{line.nonconformance.ncrNo}</code> {severityLabel(t, line.nonconformance.severity)}
                            </>
                          )}
                        </td>
                        <td>{statusLabel(t, line.status)}</td>
                        <td>
                          {line.canRecord && writable ? (
                            <button type="button" data-act="record" onClick={() => setDialog({ kind: 'result', testId: line.id })}>
                              {t('qms.material.act.record')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </StateBoundary>
        </>
      )}
      {open === undefined ? null : open.kind === 'register' ? (
        <RegisterDialog contracts={performed} initialContractId={contractId} onClose={() => setDialog(undefined)} />
      ) : (
        <ResultDialog test={open.test} onClose={() => setDialog(undefined)} />
      )}
      <p className="prototype-note">{t('qms.material.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
