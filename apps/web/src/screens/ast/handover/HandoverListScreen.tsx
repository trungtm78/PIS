import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { useHandovers } from './hooks';
import { kindLabel, statusLabel } from './labels';
import { canDraft } from './model';
import { CreateDialog } from './HandoverDialogs';
import '../../qms/qms.css';

/** The address of the screen that shows one handover, its punch list and its decision (AST-02). */
export const handoverLink = (id: string): string => `/ast/ast-02?id=${id}`;

/**
 * AST-01: the handovers of the works to the units that receive them (ST-AST-001, AST 3.1). Each shows its number, contract, kind, the unit that receives the work, how many critical items of the
 * punch list are still open and its status; the project office drafts one for a contract that is being performed or completed. The server judges every command again: the state of the contract,
 * the approved completion minutes and the permits of the handover gate.
 */
export default function HandoverListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <HandoverListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HandoverListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contracts = useContracts();
  // Whoever may read handovers and not the register still reads them: only the filter and the choice of a contract are missing.
  const options = useMemo(() => contracts.data ?? [], [contracts.data]);
  const wanted = search.get('contract') ?? '';
  const contractId = options.some((contract) => contract.id === wanted) ? wanted : '';
  const handovers = useHandovers(contractId);
  const [creating, setCreating] = useState(false);
  // A tenant with no handover is not an empty screen: the project office still drafts the first.
  const state = useScreenState({ isLoading: handovers.isLoading, error: handovers.error, data: handovers.data, isEmpty: () => false });
  const lines = handovers.data ?? [];
  const open = useMemo(() => options.filter((contract) => contract.status === 'ACTIVE' || contract.status === 'COMPLETED'), [options]);
  const choose = (id: string): void => setSearch(id === '' ? {} : { contract: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.handover.list.title')}</h1>
          <p>{t('ast.handover.list.subtitle')}</p>
        </div>
        {canDraft(permissions, mode) && open.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              {t('ast.handover.create.action')}
            </button>
          </div>
        ) : null}
      </div>
      {options.length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="handovers-contract">{t('ast.handover.filter.contract')}</label>
            <select id="handovers-contract" value={contractId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('ast.handover.filter.all')}</option>
              {options.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void handovers.refetch()}>
        <div className="card">
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="no-handovers">
              {t('ast.handover.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="handovers">
              <thead>
                <tr>
                  <th scope="col">{t('ast.handover.column.no')}</th>
                  <th scope="col">{t('ast.handover.column.contract')}</th>
                  <th scope="col">{t('ast.handover.column.kind')}</th>
                  <th scope="col">{t('ast.handover.column.unit')}</th>
                  <th scope="col">{t('ast.handover.column.critical')}</th>
                  <th scope="col">{t('ast.handover.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('ast.handover.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} data-handover={line.id} data-status={line.status}>
                    <td data-testid="no">{line.handoverNo}</td>
                    <td data-testid="contract">{line.contract.code}</td>
                    <td data-testid="kind">{kindLabel(t, line.kind)}</td>
                    <td data-testid="unit">{line.recipientUnit.name}</td>
                    <td data-testid="critical">
                      {line.openCriticalCount > 0 ? (
                        <span className="qms-badge danger" role="status">
                          {t('ast.handover.critical.notice', { count: line.openCriticalCount })}
                        </span>
                      ) : (
                        t('ast.handover.critical.none')
                      )}
                      <small className="sub qms-regime">{t('ast.handover.items.count', { count: line.itemCount })}</small>
                    </td>
                    <td>
                      <span className={line.status === 'ACCEPTED' ? 'qms-badge ok' : line.status === 'REJECTED' ? 'qms-badge danger' : 'qms-badge'} data-testid="status">
                        {statusLabel(t, line.status)}
                      </span>
                    </td>
                    <td>
                      <Link className="button" to={handoverLink(line.id)} data-open={line.id}>
                        {t('ast.handover.open.action')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      {creating ? <CreateDialog contracts={open} initialContractId={contractId} onClose={() => setCreating(false)} /> : null}
      <p className="prototype-note">{t('ast.handover.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
