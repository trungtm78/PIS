import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DecideAction, HandoverAction, ProposeAction } from './archive/DossierActions';
import { useDossiers } from './archive/hooks';
import { blockerMessage, classLabel, dossierStatusLabel } from './archive/labels';
import { retentionIsOver } from './archive/rules';
import { DOSSIER_STATUSES, READ_DOSSIER_PERMISSION } from './archive/types';
import type { Dossier, DossierStatus } from './archive/types';

const POLICY_PATH = '/doc/doc-18';
const NONE = '—';
/** The states a disposal can be proposed from: only there does what stops it matter to the reader. */
const DISPOSAL_STATES: readonly DossierStatus[] = ['CLOSED', 'HANDED_OVER', 'ARCHIVED'];

type Pending = { kind: 'handover' | 'propose' | 'decide'; id: string } | undefined;

/** The day of the browser as `YYYY-MM-DD`, to tell a retention that is over from one that runs. */
const today = (): string => new Date().toLocaleDateString('sv');

/**
 * DOC-17: the dossiers and their archive (ST-DOC-017, DOC.md F11). A closed dossier is handed over to the archive; one whose retention is over is proposed for disposal and the council decides it, someone other than the
 * proposer. The server judges every step again; the screen offers only the steps it says the caller may take.
 */
export default function DossiersScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // A step being filled in belongs to one tenant: a switch starts the screen over.
  return <DossiersContent key={tenantId ?? 'none'} route={route} />;
}

function DossiersContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const mayRead = permissions === undefined || permissions.includes(READ_DOSSIER_PERMISSION);
  const list = useDossiers(mayRead);
  const [status, setStatus] = useState<DossierStatus | ''>('');
  const [pending, setPending] = useState<Pending>(undefined);
  const dossiers = (list.data ?? []).filter((dossier) => status === '' || dossier.status === status);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const chosen = pending === undefined ? undefined : (list.data ?? []).find((dossier) => dossier.id === pending.id);
  const close = (): void => setPending(undefined);
  const day = today();

  const actions = (dossier: Dossier) =>
    frozen ? null : (
      <>
        {dossier.mayHandover ? (
          <button type="button" onClick={() => setPending({ kind: 'handover', id: dossier.id })}>
            {t('doc.archive.handover.action')}
          </button>
        ) : null}
        {dossier.mayProposeDisposal ? (
          <button type="button" onClick={() => setPending({ kind: 'propose', id: dossier.id })}>
            {t('doc.archive.propose.action')}
          </button>
        ) : null}
        {dossier.mayDecideDisposal ? (
          <button type="button" onClick={() => setPending({ kind: 'decide', id: dossier.id })}>
            {t('doc.archive.decide.action')}
          </button>
        ) : null}
      </>
    );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.archive.dossiers.title')}</h1>
          <p>{t('doc.archive.dossiers.subtitle')}</p>
        </div>
        <Link to={POLICY_PATH}>{t('doc.archive.policy.link')}</Link>
      </div>
      {!mayRead ? (
        <p className="callout warning" role="status" data-testid="no-read">
          {t('doc.archive.dossiers.denied')}
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="dossier-status">{t('doc.archive.filter.status.label')}</label>
            <select id="dossier-status" value={status} onChange={(event) => setStatus(event.target.value as DossierStatus | '')}>
              <option value="">{t('doc.archive.filter.status.all')}</option>
              {DOSSIER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {dossierStatusLabel(t, value)}
                </option>
              ))}
            </select>
          </div>
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            <div className="tablewrap">
              <table aria-label={t('doc.archive.dossiers.aria')} data-testid="dossiers">
                <thead>
                  <tr>
                    <th scope="col">{t('doc.archive.col.code')}</th>
                    <th scope="col">{t('doc.archive.col.title')}</th>
                    <th scope="col">{t('doc.archive.col.unit')}</th>
                    <th scope="col">{t('doc.archive.col.status')}</th>
                    <th scope="col">{t('doc.archive.col.retention')}</th>
                    <th scope="col">{t('doc.archive.col.archive')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('doc.archive.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dossiers.map((dossier) => (
                    <tr key={dossier.id} data-dossier={dossier.id} data-status={dossier.status}>
                      <td>{t('doc.archive.dossier.code', { code: dossier.dossierCode, year: dossier.year })}</td>
                      <td>{dossier.title}</td>
                      <td>{dossier.unitName === '' ? NONE : dossier.unitName}</td>
                      <td>
                        <span className={dossier.status === 'DISPOSED' ? 'pill gray' : 'pill green'}>{dossierStatusLabel(t, dossier.status)}</span>
                        {dossier.holdActive ? (
                          <span className="pill red" data-testid="hold">
                            {t('doc.archive.hold.active')}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {dossier.status === 'OPEN' ? (
                          NONE
                        ) : dossier.provisional ? (
                          <span className="pill amber" data-testid="provisional">
                            {t('doc.archive.retention.provisional')}
                          </span>
                        ) : (
                          <>
                            {dossier.retentionClass === null ? NONE : classLabel(t, dossier.retentionClass)}
                            {dossier.retentionEndsOn === null ? null : ` · ${t('doc.archive.retention.until', { date: dossier.retentionEndsOn })}`}
                            {retentionIsOver(dossier, day) ? (
                              <span className="pill amber" data-testid="over">
                                {t('doc.archive.retention.over')}
                              </span>
                            ) : null}
                            {dossier.disposalBlocker !== null && DISPOSAL_STATES.includes(dossier.status) ? (
                              <small data-testid="blocker" data-blocker={dossier.disposalBlocker}>
                                {blockerMessage(t, dossier.disposalBlocker)}
                              </small>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td>{dossier.archiveRef === null ? NONE : t('doc.archive.archive.ref', { ref: dossier.archiveRef })}</td>
                      <td>{actions(dossier)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </StateBoundary>
          {chosen === undefined || pending === undefined ? null : pending.kind === 'handover' ? (
            <HandoverAction key={chosen.id} dossier={chosen} onClose={close} />
          ) : pending.kind === 'propose' ? (
            <ProposeAction key={chosen.id} dossier={chosen} onClose={close} />
          ) : (
            <DecideAction key={chosen.id} dossier={chosen} onClose={close} />
          )}
        </>
      )}
      <p className="prototype-note">{t('doc.archive.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
