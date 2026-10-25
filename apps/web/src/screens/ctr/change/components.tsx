import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts, useProjectOptions } from '../hooks';
import { statusLabel, stageLabel } from './labels';
import { CHANGEABLE_CONTRACT_STATUSES, chainLink, signedAmountText } from './model';
import type { ChangeRequest, ChangeStatus } from './model';
import '../ctr.css';

/** The status of a request as a word, never as a colour alone. */
export function ChangeBadge({ status }: { status: ChangeStatus }) {
  const { t } = useTranslation();
  return (
    <span className={status === 'WITHDRAWN' || status === 'REJECTED' ? 'ctr-badge warning' : 'ctr-badge'} data-testid="change-status">
      {statusLabel(t, status)}
    </span>
  );
}

/** The project whose chain is read or set: a screen opened without one asks for it. */
export function ProjectPicker({ onPick }: { onPick(projectId: string): void }) {
  const { t } = useTranslation();
  const projects = useProjectOptions();
  const state = useScreenState({ isLoading: projects.isLoading, error: projects.error, data: projects.data });
  return (
    <StateBoundary state={state} onRetry={() => void projects.refetch()}>
      <article className="card" aria-label={t('ctr.change.pick.project.title')}>
        <h2>{t('ctr.change.pick.project.title')}</h2>
        <div className="field" data-field="change-project">
          <label htmlFor="change-project">{t('ctr.change.pick.project.label')}</label>
          <select id="change-project" value="" onChange={(event) => (event.target.value === '' ? undefined : onPick(event.target.value))}>
            <option value="">{t('ctr.change.pick.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        </div>
      </article>
    </StateBoundary>
  );
}

/** The contract a change is raised on: only one that is being performed can take one. */
export function ContractPicker({ onPick }: { onPick(contractId: string): void }) {
  const { t } = useTranslation();
  const contracts = useContracts();
  const offered = (contracts.data ?? []).filter((contract) => CHANGEABLE_CONTRACT_STATUSES.includes(contract.status));
  const state = useScreenState({ isLoading: contracts.isLoading, error: contracts.error, data: contracts.data === undefined ? undefined : offered });
  return (
    <StateBoundary state={state} onRetry={() => void contracts.refetch()}>
      <article className="card" aria-label={t('ctr.change.pick.contract.title')}>
        <h2>{t('ctr.change.pick.contract.title')}</h2>
        <div className="field" data-field="change-contract">
          <label htmlFor="change-contract">{t('ctr.change.pick.contract.label')}</label>
          <select id="change-contract" value="" onChange={(event) => (event.target.value === '' ? undefined : onPick(event.target.value))}>
            <option value="">{t('ctr.change.pick.contract.choose')}</option>
            {offered.map((contract) => (
              <option key={contract.id} value={contract.id}>
                {`${contract.code} · ${contract.title ?? contract.projectName}`}
              </option>
            ))}
          </select>
        </div>
      </article>
    </StateBoundary>
  );
}

/** The figures of a request, in the order of the board: what was estimated, what was assessed, what was approved, and the schedule. Only the staff have them. */
export function Figures({ request, locale }: { request: ChangeRequest; locale: string }) {
  const { t } = useTranslation();
  const { detail } = request;
  if (detail === undefined) return null;
  const money = (value: string | null): string => {
    const shown = signedAmountText(value, locale);
    return shown === null ? t('ctr.change.none.text') : t('ctr.value.amount', { amount: shown });
  };
  return (
    <dl className="ctr-facts" data-testid="figures">
      <dt>{t('ctr.change.field.estimated')}</dt>
      <dd data-testid="estimated">{money(detail.estimatedDeltaVnd)}</dd>
      <dt>{t('ctr.change.field.evaluated')}</dt>
      <dd data-testid="evaluated">{money(detail.evaluatedDeltaVnd)}</dd>
      <dt>{t('ctr.change.field.approved')}</dt>
      <dd data-testid="approved">{money(detail.approvedDeltaVnd)}</dd>
      <dt>{t('ctr.change.field.days')}</dt>
      <dd data-testid="days">{t('ctr.change.days.value', { days: detail.scheduleImpactDays })}</dd>
    </dl>
  );
}

/** The requests of a contract as a table, the oldest first, each with a link to the board of the chain. */
export function RequestsTable({ requests, projectId, locale }: { requests: readonly ChangeRequest[]; projectId: string; locale: string }) {
  const { t } = useTranslation();
  return (
    <table className="table" data-testid="requests">
      <thead>
        <tr>
          <th scope="col">{t('ctr.change.column.code')}</th>
          <th scope="col">{t('ctr.change.column.stage')}</th>
          <th scope="col">{t('ctr.change.column.status')}</th>
          <th scope="col" className="ctr-amount">
            {t('ctr.change.column.estimated')}
          </th>
          <th scope="col" className="ctr-amount">
            {t('ctr.change.column.evaluated')}
          </th>
          <th scope="col" className="ctr-amount">
            {t('ctr.change.column.days')}
          </th>
        </tr>
      </thead>
      <tbody>
        {requests.map((request) => (
          <tr key={request.id} data-request={request.id}>
            <td>
              <Link to={chainLink(projectId, request.contract.id)}>{request.code ?? request.id}</Link>
            </td>
            <td>{stageLabel(t, request.stage)}</td>
            <td>
              <ChangeBadge status={request.status} />
            </td>
            <td className="ctr-amount">{signedAmountText(request.detail?.estimatedDeltaVnd ?? null, locale) ?? t('ctr.change.none.text')}</td>
            <td className="ctr-amount">{signedAmountText(request.detail?.evaluatedDeltaVnd ?? null, locale) ?? t('ctr.change.none.text')}</td>
            <td className="ctr-amount">{request.detail === undefined ? t('ctr.change.none.text') : request.detail.scheduleImpactDays}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
