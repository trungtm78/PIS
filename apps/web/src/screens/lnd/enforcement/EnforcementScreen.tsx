import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useHouseholds } from '../household/hooks';
import { usePlans } from '../plan/hooks';
import { useParcels, useProjectOptions, useUnits } from '../read-hooks';
import '../../prj/prj.css';
import '../lnd.css';
import { AdvanceDialog, StartDialog } from './EnforcementDialogs';
import { useCases } from './hooks';
import { stepLabel } from './labels';
import { ENFORCEABLE_PARCELS, STANDING_PLANS, canEnforce, moveChoices } from './model';
import type { CaseLine } from './model';

const NONE = '—';

type Dialog = { kind: 'start' } | { kind: 'advance'; caseId: string };

/**
 * LND-09: the enforcement of a land recovery (ST-LND-011, LND 3.3, UC-LND-03, UAT-AC385). A case is opened for a parcel whose recovery was decided and for a household that was offered the money, and goes through persuasion,
 * the notice, the decision that forms the enforcement team, the decision to enforce, the execution and the completion, each decision with its document, by someone other than the person who drew the case up; it can be suspended
 * and resumed. The households are shown masked only. The server judges every command again.
 */
export default function EnforcementScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or person starts the screen over.
  return <EnforcementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EnforcementContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const list = useCases(projectId);
  const may = canEnforce(permissions, mode);
  const parcels = useParcels(may ? projectId : undefined);
  const households = useHouseholds(may ? projectId : undefined);
  const plans = usePlans(may ? projectId : undefined);
  const units = useUnits(may && projectId !== undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const lines = list.data ?? [];
  // A dialog on a case names the case, not a copy of it: the case is read again from the table each time it is drawn, so that a retry sends the version the table shows now.
  const target = dialog?.kind === 'advance' ? lines.find((line) => line.id === dialog.caseId) : undefined;
  const choose = (id: string): void => {
    setDialog(undefined);
    setParams(id === '' ? {} : { project: id });
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.enforcement.page.title')}</h1>
          <p>{t('lnd.enforcement.page.subtitle')}</p>
        </div>
        {may && projectId !== undefined ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'start' })}>
              {t('lnd.enforcement.start.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.enforcement.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="enforcement-project">{t('lnd.enforcement.project.label')}</label>
          <select id="enforcement-project" value={projectId ?? ''} onChange={(event) => choose(event.target.value)}>
            <option value="">{t('lnd.enforcement.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.enforcement.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="empty">
              {t('lnd.enforcement.empty.notice')}
            </p>
          ) : (
            <div className="tablewrap">
              <table className="table" aria-label={t('lnd.enforcement.list.aria')} data-testid="cases">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.enforcement.col.parcel')}</th>
                    <th scope="col">{t('lnd.enforcement.col.household')}</th>
                    <th scope="col">{t('lnd.enforcement.col.step')}</th>
                    <th scope="col">{t('lnd.enforcement.col.started')}</th>
                    <th scope="col">{t('lnd.enforcement.col.planned')}</th>
                    <th scope="col">{t('lnd.enforcement.col.executed')}</th>
                    <th scope="col">{t('lnd.enforcement.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <CaseRow key={line.id} line={line} may={may} onAdvance={() => setDialog({ kind: 'advance', caseId: line.id })} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </StateBoundary>
      )}
      {dialog?.kind === 'start' && projectId !== undefined && may ? (
        <StartDialog
          projectId={projectId}
          parcels={(parcels.data ?? []).filter((parcel) => ENFORCEABLE_PARCELS.includes(parcel.status) && parcel.recoveryDecisionOn !== null)}
          households={households.data ?? []}
          plans={(plans.data ?? []).filter((plan) => STANDING_PLANS.includes(plan.status))}
          authorities={units.data ?? []}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {target !== undefined && may && moveChoices(target).length > 0 ? <AdvanceDialog key={target.id} line={target} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.enforcement.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function CaseRow({ line, may, onAdvance }: { line: CaseLine; may: boolean; onAdvance(): void }) {
  const { t } = useTranslation();
  return (
    <tr data-case={line.id} data-step={line.step}>
      <td>
        <code>{line.parcelCode}</code>
      </td>
      <td>
        {line.household === null ? (
          NONE
        ) : (
          <>
            <code>{line.household.code}</code> {line.household.headName}
          </>
        )}
      </td>
      <td>
        <span className={`pill ${line.step === 'COMPLETED' ? 'green' : 'gray'}`}>{stepLabel(t, line.step)}</span>
        {line.step === 'SUSPENDED' && line.suspendReason !== null ? (
          <small className="sub" data-testid="suspend-reason">
            {line.suspendReason}
          </small>
        ) : null}
      </td>
      <td>{line.startedOn}</td>
      <td>{line.plannedOn ?? NONE}</td>
      <td>{line.executedOn ?? NONE}</td>
      <td>
        {may && moveChoices(line).length > 0 ? (
          <button type="button" aria-label={t('lnd.enforcement.advance.aria', { parcel: line.parcelCode })} onClick={onAdvance}>
            {t('lnd.enforcement.advance.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
