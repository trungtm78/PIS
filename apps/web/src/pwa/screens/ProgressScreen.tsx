import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { StatusPill } from '../../ui';
import { useNodePackages, useProcessTree } from '../../screens/bid/workflow/hooks';
import { READ_PERMISSION, billions, fullDay, vietnamDay, vietnamTime } from '../../screens/bid/workflow/model';
import type { TreeDto, TreeNodeDto } from '../../screens/bid/workflow/model';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

const START_PATH = '/m/dashboard';
/** The full progress tree, for the person at a desk. */
export const FULL_TREE_PATH = '/bid/bid-27';
const NO_FILTERS = {};

/** The steps of each selection method in the order of the workflow, with the terminal states apart: the outline of the tree as a list a thumb can read. */
export function outlineOf(tree: TreeDto): { methods: Array<{ method: TreeNodeDto; steps: TreeNodeDto[] }>; terminals: Array<{ terminal: 'NOT_STARTED' | 'COMPLETED' | 'CANCELLED'; count: number }> } {
  const methods = tree.nodes.filter((node) => node.kind === 'METHOD' && node.count > 0).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.label ?? '').localeCompare(b.label ?? ''));
  return {
    methods: methods.map((method) => ({ method, steps: tree.nodes.filter((node) => node.kind === 'STEP' && node.method === method.method && node.count > 0).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) })),
    terminals: (['NOT_STARTED', 'COMPLETED', 'CANCELLED'] as const).map((terminal) => ({ terminal, count: tree.nodes.filter((node) => node.kind === 'TERMINAL' && node.terminal === terminal).reduce((sum, node) => sum + node.count, 0) })).filter((entry) => entry.count > 0),
  };
}

/**
 * The procurement progress on the phone (PWA-09, YCK.01): the drill-down of the funnel on the leader dashboard, the same reading as BID-27 (`getPackageProcessTree`,
 * `listPackageProcessTreeNodePackages`) laid out as one column: the counts at the top, then each selection method with its steps in order, and a tap on a step opens
 * the packages in it. The graph of BID-27 needs a wide screen; this is the same numbers as a list, so nothing differs from the full screen.
 */
export default function ProgressScreen() {
  const { tenant, permissions } = useSession();
  if (permissions !== undefined && !permissions.includes(READ_PERMISSION)) return <Denied />;
  return <ProgressContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function Denied() {
  const { t } = useTranslation();
  return (
    <section className="pwa-screen" data-screen-id="PWA-09" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} label={t('pwa2.progress.back.link')} />
      <div className="heading">
        <h1 id="screen-title">{t('pwa2.progress.page.title')}</h1>
      </div>
      <StateBoundary state="denied" />
    </section>
  );
}

function ProgressContent() {
  const { t, locale } = useTranslation();
  const tree = useProcessTree(NO_FILTERS);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: tree.isLoading, error: tree.data === undefined ? tree.error : undefined, data: tree.data, isEmpty: () => false });
  const data = tree.data;
  const outline = data === undefined ? undefined : outlineOf(data);
  const asOf = data === undefined ? undefined : `${fullDay(vietnamDay(data.as_of))} ${vietnamTime(data.as_of)}`;
  const kpi = data?.kpis;
  return (
    <section className="pwa-screen" data-screen-id="PWA-09" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} label={t('pwa2.progress.back.link')} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa2.progress.page.title')}</h1>
          <p>{t('pwa2.progress.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void tree.refetch()}>
        {data === undefined || kpi === undefined || outline === undefined ? null : (
          <>
            {tree.isError ? (
              <p className="callout warning" role="status" data-testid="stale">
                {t('prc1.stale.text', { time: asOf ?? '' })}
              </p>
            ) : null}
            {data.truncated ? (
              <p className="callout" role="status">
                {t('prc1.truncated.text')}
              </p>
            ) : null}
            <ul className="pwa-tiles" aria-label={t('prc1.kpi.group.label')} data-testid="kpis">
              <li className="pwa-tile" data-tile="total">
                <span>{t('prc1.kpi.total.label')}</span>
                <strong>{data.total.count}</strong>
              </li>
              <li className="pwa-tile" data-tile="running">
                <span>{t('prc1.kpi.running.label')}</span>
                <strong>{kpi.running}</strong>
              </li>
              <li className="pwa-tile" data-tile="late" {...(kpi.late > 0 ? { 'data-tone': 'danger' } : {})}>
                <span>{t('prc1.kpi.late.label')}</span>
                <strong>{kpi.late}</strong>
              </li>
              <li className="pwa-tile" data-tile="value">
                <span>{t('prc1.kpi.value.label')}</span>
                <strong>{billions(data.total.value_vnd, locale)}</strong>
                <span className="pwa-unit">{t('prc1.unit.billion.name')}</span>
              </li>
            </ul>
            <p className="sub">{asOf === undefined ? '' : t('pwa2.progress.asOf', { time: asOf })}</p>
            {outline.methods.length === 0 ? (
              <div className="card statecard pwa-empty" role="status" data-testid="empty">
                <h2>{t('prc1.funnel.empty.text')}</h2>
              </div>
            ) : (
              outline.methods.map(({ method, steps }) => (
                <section key={method.id} className="ui-section" aria-label={method.label ?? method.method ?? method.id} data-method={method.method}>
                  <header className="ui-section__head">
                    <h2 className="ui-section__title">{method.label ?? method.method}</h2>
                    <span className="ui-section__status">{t('ui.processTree.node.packages', { count: method.count })}</span>
                  </header>
                  <ol className="pwa-steps-list">
                    {steps.map((step) => (
                      <li key={step.id} data-step={step.id}>
                        <button type="button" className="pwa-step pwa-touch" aria-expanded={open === step.id} data-action="step" onClick={() => setOpen(open === step.id ? undefined : step.id)}>
                          <span className="pwa-step-name">{step.label ?? step.step_code}</span>
                          <strong>{t('ui.processTree.node.packages', { count: step.count })}</strong>
                          {step.late_count > 0 ? <StatusPill tone="danger" icon="⛔">{t('ui.processTree.node.late', { count: step.late_count })}</StatusPill> : <StatusPill tone="success" icon="✓">{t('ui.processTree.health.ok')}</StatusPill>}
                          {step.median_days === null ? null : <span className="pwa-unit">{t('pwa2.progress.median', { days: step.median_days })}</span>}
                        </button>
                        {open === step.id ? <StepPackages nodeId={step.id} locale={locale} /> : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ))
            )}
            {outline.terminals.length === 0 ? null : (
              <ul className="pwa-lines" aria-label={t('pwa2.progress.terminals.aria')} data-testid="terminals">
                {outline.terminals.map((node) => (
                  <li key={node.terminal} data-terminal={node.terminal}>
                    {node.terminal === 'NOT_STARTED' ? t('prc1.status.notStarted.name') : node.terminal === 'COMPLETED' ? t('prc1.status.completed.name') : t('prc1.status.cancelled.name')}: <strong>{node.count}</strong>
                  </li>
                ))}
              </ul>
            )}
            <p>
              <Link className="ui-button ui-button--outline pwa-touch" to={FULL_TREE_PATH} data-testid="pwa-full-tree">
                {t('pwa2.progress.full.link')}
              </Link>
            </p>
          </>
        )}
      </StateBoundary>
    </section>
  );
}

function StepPackages({ nodeId, locale }: { nodeId: string; locale: string }) {
  const { t } = useTranslation();
  const packages = useNodePackages(nodeId, NO_FILTERS, undefined);
  if (packages.isLoading) {
    return (
      <div role="status" aria-busy="true" aria-label={t('states.loading.label')}>
        <span className="ui-skeleton ui-skeleton--line" />
      </div>
    );
  }
  if (packages.data === undefined) {
    return (
      <p role="alert">
        {t('pwa2.progress.packages.failed')}{' '}
        <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={() => void packages.refetch()}>
          {t('states.retry.action')}
        </button>
      </p>
    );
  }
  if (packages.data.items.length === 0) return <p role="status">{t('pwa2.progress.packages.none')}</p>;
  return (
    <>
      <ul className="pwa-cards pwa-cards--inner" aria-label={t('pwa2.progress.packages.aria')} data-testid="packages">
        {packages.data.items.map((row) => (
          <li key={row.package_id} className="pwa-subcard" data-package={row.package_id} data-late={row.late ? 'yes' : 'no'}>
            <div className="pwa-card-head">
              <h3>{row.package_code}</h3>
              {row.late ? <StatusPill tone="danger">{t('pwa2.progress.packages.lateDays', { days: row.late_days })}</StatusPill> : null}
            </div>
            {row.title === null ? null : <p className="pwa-clamp">{row.title}</p>}
            <dl className="pwa-facts">
              <dt>{t('pwa2.progress.packages.project')}</dt>
              <dd>{row.project.name ?? row.project.code}</dd>
              <dt>{t('pwa2.progress.packages.value')}</dt>
              <dd>
                {billions(row.value_vnd, locale)} <span className="pwa-unit">{t('prc1.unit.billion.name')}</span>
              </dd>
              <dt>{t('pwa2.progress.packages.owner')}</dt>
              <dd>{row.owner?.name ?? t('pwa2.progress.packages.noOwner')}</dd>
              {row.days_in_step === null ? null : (
                <>
                  <dt>{t('pwa2.progress.packages.days')}</dt>
                  <dd>{t('pwa2.progress.packages.daysValue', { days: row.days_in_step.calendar_days })}</dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>
      {packages.data.next_cursor !== null || packages.data.truncated ? <p className="sub">{t('pwa2.progress.packages.more')}</p> : null}
    </>
  );
}
