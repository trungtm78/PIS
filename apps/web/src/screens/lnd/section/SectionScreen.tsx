import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionDialog } from '../components';
import { canManage, todayInVietnam } from '../model';
import { useProjectOptions } from '../read-hooks';
import { HandoverDialog } from './HandoverDialog';
import { useContracts, useSectionLines } from './hooks';
import { sectionStatusLabel } from './labels';
import { canHandOver, canHandover, ratioText, totalsOf } from './model';
import type { SectionLine } from './model';
import '../lnd.css';

type Dialog = { kind: 'section' } | { kind: 'handover'; section: SectionLine };

/**
 * LND-10: the sections of a project that land is handed over in, by kilometre or by area (ST-LND-009, LND 3.4). Each line says what the section needs, what has been handed over
 * and how far that is, the contract that receives it and where it stands; the share of the whole project is the sum of the areas, not an average of the shares. A section
 * is handed over to the contract it names, in steps, and the server refuses what passes the area it needs or a contract that is not active.
 */
export default function SectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <SectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SectionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const sections = useSectionLines(projectId);
  const contracts = useContracts(projectId !== undefined);
  const codes = useMemo(() => new Map((contracts.data ?? []).map((contract) => [contract.id, contract.code])), [contracts.data]);
  const ofProject = useMemo(() => (contracts.data ?? []).filter((contract) => contract.projectId === projectId), [contracts.data, projectId]);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const mayManage = canManage(permissions, mode);
  const mayHandOver = canHandover(permissions, mode);
  const today = todayInVietnam();
  // A project with no section yet is not an empty screen: the officer still needs the button that creates the first one.
  const state = useScreenState({ isLoading: sections.isLoading, error: sections.error, data: sections.data, isEmpty: () => false });
  const totals = useMemo(() => totalsOf(sections.data ?? []), [sections.data]);
  const numbers = useMemo(() => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [locale]);
  const area = (value: string): string => numbers.format(Number(value));
  const contractName = (section: SectionLine): string => (section.contractId === null ? t('lnd.sections.contract.none') : (codes.get(section.contractId) ?? section.contractId.slice(0, 8)));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.sections.page.title')}</h1>
          <p>{t('lnd.sections.page.subtitle')}</p>
        </div>
        {mayManage && projectId !== undefined ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'section' })}>
              {t('lnd.sections.create.action')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="lnd-project">{t('lnd.parcels.project.label')}</label>
          <select id="lnd-project" value={projectId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { project: event.target.value })}>
            <option value="">{t('lnd.parcels.project.choose')}</option>
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
          {t('lnd.sections.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void sections.refetch()}>
          <div className="lnd-tiles" data-testid="totals">
            <div className="card">
              <span className="sub">{t('lnd.sections.totals.sections')}</span>
              <strong data-testid="total-sections">{t('lnd.sections.totals.sections.value', { done: totals.handedOver, count: totals.count })}</strong>
            </div>
            <div className="card">
              <span className="sub">{t('lnd.sections.totals.required')}</span>
              <strong data-testid="total-required">{area(totals.requiredAreaM2)}</strong>
            </div>
            <div className="card">
              <span className="sub">{t('lnd.sections.totals.handed')}</span>
              <strong data-testid="total-handed">{area(totals.handedAreaM2)}</strong>
            </div>
            <div className="card">
              <span className="sub">{t('lnd.sections.totals.ratio')}</span>
              <strong data-testid="total-ratio">{t('lnd.sections.ratio.value', { ratio: totals.ratio })}</strong>
            </div>
          </div>
          <div className="card">
            {(sections.data ?? []).length === 0 ? (
              <p className="callout" role="status" data-testid="no-sections">
                {t('lnd.sections.none.notice')}
              </p>
            ) : (
              <table className="table" data-testid="sections">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.sections.column.section')}</th>
                    <th scope="col">{t('lnd.sections.column.km')}</th>
                    <th scope="col" className="lnd-numeric">
                      {t('lnd.sections.column.required')}
                    </th>
                    <th scope="col" className="lnd-numeric">
                      {t('lnd.sections.column.handed')}
                    </th>
                    <th scope="col">{t('lnd.sections.column.contract')}</th>
                    <th scope="col">{t('lnd.sections.column.target')}</th>
                    <th scope="col">{t('lnd.sections.column.status')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('lnd.sections.column.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(sections.data ?? []).map((section) => (
                    <tr key={section.id} data-section={section.code} data-status={section.status}>
                      <td>
                        <strong>{section.code}</strong> <span className="sub">{section.name}</span>
                      </td>
                      <td>{section.fromKm === null && section.toKm === null ? t('lnd.sections.km.none') : t('lnd.sections.km.range', { from: section.fromKm ?? '—', to: section.toKm ?? '—' })}</td>
                      <td className="lnd-numeric">{area(section.requiredAreaM2)}</td>
                      <td className="lnd-numeric">
                        <span data-testid="handed">{area(section.handedAreaM2)}</span> <span className="sub">{t('lnd.sections.ratio.value', { ratio: ratioText(section.handedAreaM2, section.requiredAreaM2) })}</span>
                      </td>
                      <td data-testid="contract">{contractName(section)}</td>
                      <td>{section.targetDate ?? t('lnd.sections.target.none')}</td>
                      <td>
                        <span className={section.status === 'HANDED_OVER' ? 'lnd-badge' : 'lnd-badge warning'} data-testid="status">
                          {sectionStatusLabel(t, section.status)}
                        </span>
                      </td>
                      <td>
                        {mayHandOver && canHandOver(section) ? (
                          <button type="button" data-handover={section.code} onClick={() => setDialog({ kind: 'handover', section })}>
                            {t('lnd.sections.handover.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </StateBoundary>
      )}
      {dialog?.kind === 'section' && projectId !== undefined ? <SectionDialog projectId={projectId} contracts={ofProject} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'handover' ? <HandoverDialog section={dialog.section} contractCode={contractName(dialog.section)} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.sections.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
