import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar } from '../../ui';
import { DossierPermits } from './DossierPermits';
import { DossierTable } from './DossierTable';
import { OpenDossierForm } from './OpenDossierForm';
import { useProjectOptions } from './dossier-commands';
import { MANAGE_PERMISSION, projectsWithoutDossier } from './dossier-model';
import { useDossier, useDossiers, usePermitTypes } from './hooks';
import { vietnamToday } from './model';
import './pmt.css';

const NEVER_EMPTY = (): boolean => false;
const SELECTED = 'dossier';

/** PMT-01: the legal dossier of each project, the permits of the one selected, and the form that opens the dossier of a project that has none. */
export default function DossierWorkspaceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The dossiers belong to one membership (the units and projects it reaches): a switch starts the screen over.
  return <DossierWorkspaceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DossierWorkspaceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(SELECTED) ?? undefined;
  const mayManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const today = vietnamToday();
  const dossiers = useDossiers();
  const selected = useDossier(selectedId);
  const types = usePermitTypes();
  const projects = useProjectOptions(mayManage);
  const state = useScreenState({ isLoading: dossiers.isLoading, error: dossiers.error, data: dossiers.data, isEmpty: NEVER_EMPTY });
  const lines = useMemo(() => dossiers.data ?? [], [dossiers.data]);
  const unconfirmed = useMemo(() => lines.reduce((total, line) => total + line.unconfirmedCount, 0), [lines]);
  const select = (dossierId: string): void => setParams({ [SELECTED]: dossierId });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pmt.dossier.page.title')}</h1>
          <p>{t('pmt.dossier.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void dossiers.refetch()}>
        <ContextBar items={[{ label: t('pmt.ctx.scope'), value: tenant?.name ?? t('pmt.ctx.scope.all') }, { label: t('pmt.ctx.dossiers'), value: String(lines.length) }]} />
        <div className="stack">
          {unconfirmed === 0 ? null : (
            <p className="callout warning" role="status" data-testid="unconfirmed-banner">
              {t('pmt.dossier.banner.unconfirmed', { count: unconfirmed })}
            </p>
          )}
          {lines.length === 0 ? (
            <p className="sub" data-testid="empty-dossiers">
              {t('pmt.dossier.empty.text')}
            </p>
          ) : (
            <DossierTable dossiers={lines} selectedId={selectedId} onSelect={select} />
          )}
          {selectedId === undefined ? (
            lines.length === 0 ? null : (
              <p className="sub" data-testid="pick-dossier">
                {t('pmt.dossier.pick.text')}
              </p>
            )
          ) : selected.data === null ? (
            <p className="callout warning" role="status" data-testid="no-dossier">
              {t('pmt.dossier.missing.notice')}
            </p>
          ) : selected.data === undefined ? null : (
            <DossierPermits dossier={selected.data} types={types.data ?? []} today={today} mayAdd={mayManage} />
          )}
          {mayManage ? <OpenDossierForm projects={projectsWithoutDossier(projects.data ?? [], lines)} onOpened={select} /> : <p className="sub">{t('pmt.dossier.readonly.text')}</p>}
        </div>
      </StateBoundary>
    </section>
  );
}
