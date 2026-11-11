import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FlowChart, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { FlowSeries } from '../../ui';
import { LIST_PATH } from '../prj/model';
import { useDefaultProject } from '../prj/hooks';
import { useBaseline, useComponentContracts, useEvm, useExportSCurve, useLinkContract, useSCurve } from './hooks';
import type { EvmSelection } from './hooks';
import { methodText, ragText, ragTone, reasonText, refusalText } from './labels';
import { asOfText, billions, bytesOfBase64, chartPoints, dayText, describeRefusal, idFrom, isCalendarDay, vietnamToday, vnd } from './model';
import type { EvmFigures, EvmMetricName, EvmRow, ExportFile, Rag } from './model';
import { saveBytes } from './save-file';
import './gov3.css';

const CHART_POINTS = 10;
const WHOLE = /^-?\d{1,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reasonCodes = (figures: EvmFigures): string[] => [...new Set([...figures.missing, ...Object.values(figures.unavailable)])];

function ReasonList({ codes, testId }: { codes: readonly string[]; testId: string }) {
  const { t } = useTranslation();
  if (codes.length === 0) return null;
  return (
    <ul className="gov3-reasons" data-testid={testId}>
      {codes.map((code) => {
        const text = reasonText(t, code);
        return (
          <li key={code} data-reason={code}>
            <StatusPill tone="warning">{text.reason}</StatusPill> <span className="muted">{text.hint}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** One index with its colour band as text: the colour is never the only signal. */
function IndexCell({ index, rag }: { index: string | null; rag: Rag | null }) {
  const { t } = useTranslation();
  if (index === null) return <span>{t('govb1.common.na')}</span>;
  return (
    <span>
      {index} {rag === null ? null : <StatusPill tone={ragTone(rag)}>{ragText(t, rag)}</StatusPill>}
    </span>
  );
}

/**
 * PRJ-27: earned value (governance deepening G1-4, G1-5). The figures PV, EV, AC, CPI, SPI, EAC, ETC, VAC and TCPI of the project, of a work package or of a contract on a day, against the current baseline or against
 * version 0, and the S-curve with the plan of version 0 and of the current baseline dashed. Earned value comes only from accepted quantities and actual cost only from certified payments; a figure that cannot be
 * known says why and what to do, it is never written as zero; the figures of a closed period are read from the result that was frozen with its snapshot. The contracts that carry the packages are linked here.
 */
export default function EvmScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EvmContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EvmContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode, permissions } = useSession();
  const [params] = useSearchParams();
  const named = idFrom(params.get('project'));
  // Opened without a project in the address, the first project under way of the register is taken (the register stays one link away).
  const fallback = useDefaultProject(named === undefined, 'IMPLEMENTATION');
  const projectId = named ?? fallback.project?.id;
  const today = vietnamToday();
  const [asOf, setAsOf] = useState('');
  const [scope, setScope] = useState<EvmSelection['scope']>('PROJECT');
  const [ref, setRef] = useState<string | undefined>(undefined);
  const [baselineChoice, setBaselineChoice] = useState<EvmSelection['baseline']>('CURRENT');
  const [showTable, setShowTable] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const selection = useMemo<EvmSelection>(() => ({ asOf, scope, ref, baseline: baselineChoice }), [asOf, scope, ref, baselineChoice]);
  const evm = useEvm(projectId, selection);
  const baseline = useBaseline(projectId);
  // Version 0 is known from the baseline read: without it the curve is not asked for; when that read fails or finds nothing, the curve is asked for and answers by itself.
  const curve = useSCurve(projectId, selection, baseline.isPending ? undefined : (baseline.data?.hasBaseline ?? true));
  const links = useComponentContracts(projectId);
  const exporter = useExportSCurve();
  const evmState = useScreenState({ isLoading: evm.isLoading, error: evm.error, data: evm.data, isEmpty: () => false });
  const curveState = useScreenState({ isLoading: curve.isLoading, error: curve.error, data: curve.data, isEmpty: () => false });
  const money = (value: string | null | undefined): string => vnd(value, locale);
  const view = evm.data ?? undefined;
  const writable = mode !== 'READ_ONLY';
  const needsRef = scope !== 'PROJECT' && ref === undefined;

  // The packages come from the lines of the versions of the baseline; the contracts from the links (and from the rows, when the links cannot be read).
  const packageMap = new Map<string, string>();
  for (const version of baseline.data?.versions ?? []) for (const line of version.lines) packageMap.set(line.componentId, `${line.code} · ${line.name}`);
  const packages = [...packageMap].map(([id, label]) => ({ id, label }));
  const contractMap = new Map<string, string>();
  for (const link of links.data ?? []) contractMap.set(link.contractId, link.contractCode);
  for (const row of view?.rows ?? []) for (const contract of row.contracts) contractMap.set(contract.contractId, contract.code);
  const contracts = [...contractMap].map(([id, code]) => ({ id, label: code }));

  const asOfValue = asOf === '' ? today : asOf;
  const onAsOf = (value: string): void => {
    if (value === '') setAsOf('');
    else if (isCalendarDay(value) && value <= today) setAsOf(value);
  };

  const figures = view?.figures;
  const reasons = figures === undefined ? [] : reasonCodes(figures);
  const metric = (value: string | null, name: EvmMetricName): { value: string; sub: string | undefined } =>
    value !== null ? { value: money(value), sub: undefined } : { value: t('govb1.common.na'), sub: figures?.unavailable[name] === undefined ? undefined : reasonText(t, figures.unavailable[name] as string).reason };
  const index = (value: string | null, name: EvmMetricName): { value: string; sub: string | undefined } => (value !== null ? { value, sub: undefined } : { value: t('govb1.common.na'), sub: figures?.unavailable[name] === undefined ? undefined : reasonText(t, figures.unavailable[name] as string).reason });

  const download = (file: ExportFile): void => {
    saveBytes(bytesOfBase64(file.contentBase64), file.fileName, file.contentType);
  };

  const series = (): FlowSeries[] => {
    const data = curve.data;
    if (data === null || data === undefined || data === 'NO_BASELINE') return [];
    const points = chartPoints(data.points, data.asOf, CHART_POINTS);
    const line = (pick: (point: (typeof points)[number]) => string | null): { x: string; y: number }[] =>
      points.flatMap((point) => {
        const y = billions(pick(point));
        return y === null ? [] : [{ x: dayText(point.day), y }];
      });
    const result: FlowSeries[] = [];
    const ev = line((point) => point.evVnd);
    const ac = line((point) => point.acVnd);
    if (ev.length > 0) result.push({ label: t('govb1.evm.series.ev'), style: 'actual', points: ev });
    if (ac.length > 0) result.push({ label: t('govb1.evm.series.ac'), style: 'actual', points: ac });
    result.push({ label: t('govb1.evm.series.pvV0'), style: 'plan', points: line((point) => point.pvV0Vnd) });
    result.push({ label: t('govb1.evm.series.pvCurrent'), style: 'plan', points: line((point) => point.pvCurrentVnd) });
    const day = data.points.find((point) => point.day === data.asOf);
    const marked = day === undefined ? null : billions(day.evVnd ?? day.pvCurrentVnd);
    if (day !== undefined && marked !== null) result.push({ label: t('govb1.evm.series.asOf', { day: dayText(day.day) }), style: 'actual', points: [{ x: dayText(day.day), y: marked }] });
    return result;
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb1.evm.title')}</h1>
          <p>{t('govb1.evm.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('govb1.ctx.scope'), value: tenant?.name ?? t('govb1.ctx.scope.all') },
          ...(view === undefined ? [] : [{ label: t('govb1.ctx.project'), value: view.projectCode }, { label: t('govb1.evm.ctx.baseline'), value: view.baseline.version === null ? t('govb1.common.na') : t('govb1.evm.ctx.version', { version: view.baseline.version }) }]),
        ]}
        unit={t('govb1.common.unit')}
        {...(view === undefined ? {} : { asOf: dayText(view.asOf) })}
      />
      {projectId === undefined && named === undefined && fallback.isLoading ? (
        <StateBoundary state="loading" />
      ) : projectId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('govb1.evm.noTarget')}
        </p>
      ) : (
        <>
          {named === undefined ? (
            <p className="callout" role="status" data-testid="default-project">
              {t('govb1.default.project.notice')} <Link to={LIST_PATH}>{t('govb1.default.project.link')}</Link>
            </p>
          ) : null}
          <form className="gov3-form" aria-label={t('govb1.evm.choose')} onSubmit={(event: FormEvent) => event.preventDefault()}>
            <label>
              {t('govb1.evm.asOf')}
              <input type="date" value={asOfValue} max={today} onChange={(event) => onAsOf(event.target.value)} data-testid="as-of" />
            </label>
            <label>
              {t('govb1.evm.scope')}
              <select
                value={scope}
                data-testid="scope"
                onChange={(event) => {
                  setScope(event.target.value === 'COMPONENT' ? 'COMPONENT' : event.target.value === 'CONTRACT' ? 'CONTRACT' : 'PROJECT');
                  setRef(undefined);
                }}
              >
                <option value="PROJECT">{t('govb1.evm.scope.project')}</option>
                <option value="COMPONENT">{t('govb1.evm.scope.component')}</option>
                <option value="CONTRACT">{t('govb1.evm.scope.contract')}</option>
              </select>
            </label>
            {scope === 'PROJECT' ? null : (
              <label>
                {scope === 'COMPONENT' ? t('govb1.evm.ref.component') : t('govb1.evm.ref.contract')}
                <select value={ref ?? ''} data-testid="ref" onChange={(event) => setRef(event.target.value === '' ? undefined : event.target.value)}>
                  <option value="">{t('govb1.evm.ref.choose')}</option>
                  {(scope === 'COMPONENT' ? packages : contracts).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {t('govb1.evm.baseline')}
              <select value={baselineChoice} data-testid="baseline" onChange={(event) => setBaselineChoice(event.target.value === 'V0' ? 'V0' : 'CURRENT')}>
                <option value="CURRENT">{t('govb1.evm.baseline.current')}</option>
                <option value="V0">{t('govb1.evm.baseline.v0')}</option>
              </select>
            </label>
          </form>
          <nav className="gov3-links" aria-label={t('govb1.evm.links.label')}>
            <Link to={`/prj/prj-26?project=${projectId}`} data-testid="link-baseline">
              {t('govb1.evm.link.baseline')}
            </Link>
          </nav>
          {needsRef ? (
            <p className="callout" data-testid="choose-ref">
              {t('govb1.evm.ref.needed')}
            </p>
          ) : (
            <StateBoundary state={evmState} onRetry={() => void evm.refetch()}>
              {view === undefined || figures === undefined ? (
                <p className="callout" data-testid="missing">
                  {t('govb1.evm.missing')}
                </p>
              ) : (
                <>
                  {message === undefined ? null : (
                    <p className={message.tone === 'ok' ? 'callout' : 'callout gov3-error'} role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="message">
                      {message.text}
                    </p>
                  )}
                  <SectionCard
                    title={t('govb1.evm.kpi.title', { code: view.projectCode })}
                    unit={t('govb1.common.unit')}
                    status={
                      view.source === 'FROZEN' ? (
                        <StatusPill tone="info">{t('govb1.evm.frozen')}</StatusPill>
                      ) : (
                        <StatusPill tone="neutral">{t('govb1.evm.live')}</StatusPill>
                      )
                    }
                  >
                    {view.source === 'FROZEN' ? (
                      <p className="callout" data-testid="frozen">
                        {t('govb1.evm.frozen.detail', { snapshot: view.snapshotId ?? '', hash: view.payloadSha256 ?? '', at: view.frozenAt === null ? '' : asOfText(view.frozenAt) })}
                      </p>
                    ) : null}
                    {figures.status === 'INSUFFICIENT' ? (
                      <div className="callout" role="status" data-testid="insufficient">
                        <p>
                          <strong>{t('govb1.evm.insufficient')}</strong>
                        </p>
                        <ReasonList codes={reasons} testId="reasons" />
                      </div>
                    ) : null}
                    <KpiStrip label={t('govb1.evm.kpi.title', { code: view.projectCode })}>
                      <KpiTile label={t('govb1.evm.kpi.bac')} value={metric(figures.bacVnd, 'bac').value} sub={metric(figures.bacVnd, 'bac').sub} />
                      <KpiTile label={t('govb1.evm.kpi.pv')} value={metric(figures.pvVnd, 'pv').value} sub={metric(figures.pvVnd, 'pv').sub ?? t('govb1.evm.kpi.pv.sub')} />
                      <KpiTile label={t('govb1.evm.kpi.ev')} value={metric(figures.evVnd, 'ev').value} sub={metric(figures.evVnd, 'ev').sub ?? t('govb1.evm.kpi.ev.sub')} />
                      <KpiTile label={t('govb1.evm.kpi.ac')} value={metric(figures.acVnd, 'ac').value} sub={metric(figures.acVnd, 'ac').sub ?? t('govb1.evm.kpi.ac.sub')} />
                      <KpiTile
                        label={t('govb1.evm.kpi.cpi')}
                        value={index(figures.cpi, 'cpi').value}
                        tone={figures.ragCpi === null ? 'default' : ragTone(figures.ragCpi)}
                        sub={figures.ragCpi === null ? index(figures.cpi, 'cpi').sub : <StatusPill tone={ragTone(figures.ragCpi)}>{ragText(t, figures.ragCpi)}</StatusPill>}
                      />
                      <KpiTile
                        label={t('govb1.evm.kpi.spi')}
                        value={index(figures.spi, 'spi').value}
                        tone={figures.ragSpi === null ? 'default' : ragTone(figures.ragSpi)}
                        sub={figures.ragSpi === null ? index(figures.spi, 'spi').sub : <StatusPill tone={ragTone(figures.ragSpi)}>{ragText(t, figures.ragSpi)}</StatusPill>}
                      />
                      <KpiTile label={t('govb1.evm.kpi.eac')} value={metric(figures.eacVnd, 'eac').value} sub={metric(figures.eacVnd, 'eac').sub ?? t('govb1.evm.kpi.eac.sub', { method: methodText(t, figures.eacMethod) })} />
                      <KpiTile label={t('govb1.evm.kpi.etc')} value={metric(figures.etcVnd, 'etc').value} sub={metric(figures.etcVnd, 'etc').sub} />
                      <KpiTile label={t('govb1.evm.kpi.vac')} value={metric(figures.vacVnd, 'vac').value} sub={metric(figures.vacVnd, 'vac').sub} />
                      <KpiTile label={t('govb1.evm.kpi.tcpi')} value={index(figures.tcpi, 'tcpi').value} sub={index(figures.tcpi, 'tcpi').sub} />
                      <KpiTile
                        label={t('govb1.evm.kpi.over')}
                        value={view.eacAgainstTotal === null ? t('govb1.common.na') : money(view.eacAgainstTotal.overVnd)}
                        tone={view.eacAgainstTotal !== null && WHOLE.test(view.eacAgainstTotal.overVnd) && BigInt(view.eacAgainstTotal.overVnd) > 0n ? 'danger' : 'default'}
                        sub={view.eacAgainstTotal === null ? t('govb1.evm.kpi.over.none') : view.eacAgainstTotal.overPct === null ? t('govb1.evm.kpi.over.total', { total: money(view.totalInvestmentVnd) }) : t('govb1.evm.kpi.over.pct', { pct: view.eacAgainstTotal.overPct, total: money(view.totalInvestmentVnd) })}
                      />
                    </KpiStrip>
                    <p className="muted" data-testid="formula">
                      {t('govb1.evm.formula', {
                        method: methodText(t, figures.eacMethod),
                        amber: view.policy.amberBelow ?? '',
                        red: view.policy.redBelow ?? '',
                        source: view.policy.source === 'BUILT_IN' ? t('govb1.policy.builtIn') : t('govb1.policy.rule', { version: view.policy.version }),
                      })}
                    </p>
                  </SectionCard>

                  <SectionCard title={t('govb1.evm.rows.title')} unit={t('govb1.common.unit')}>
                    <DataTable<EvmRow>
                      caption={t('govb1.evm.rows.title')}
                      rows={view.rows}
                      rowKey={(row) => row.key}
                      state={view.rows.length === 0 ? 'empty' : 'ready'}
                      columns={[
                        { key: 'package', header: t('govb1.evm.rows.package'), pinned: true, render: (row) => `${row.code} · ${row.name}` },
                        { key: 'bac', header: t('govb1.evm.kpi.bac'), align: 'right', render: (row) => money(row.bacVnd) },
                        { key: 'pv', header: t('govb1.evm.kpi.pv'), align: 'right', render: (row) => money(row.pvVnd) },
                        { key: 'ev', header: t('govb1.evm.kpi.ev'), align: 'right', render: (row) => (row.evVnd === null ? t('govb1.common.na') : money(row.evVnd)) },
                        { key: 'ac', header: t('govb1.evm.kpi.ac'), align: 'right', render: (row) => (row.acVnd === null ? t('govb1.common.na') : money(row.acVnd)) },
                        { key: 'cpi', header: t('govb1.evm.kpi.cpi'), render: (row) => <IndexCell index={row.cpi} rag={row.ragCpi} /> },
                        { key: 'spi', header: t('govb1.evm.kpi.spi'), render: (row) => <IndexCell index={row.spi} rag={row.ragSpi} /> },
                        { key: 'contracts', header: t('govb1.evm.rows.contracts'), render: (row) => (row.contracts.length === 0 ? t('govb1.evm.rows.noContract') : row.contracts.map((contract) => `${contract.code} (${money(contract.valueVnd)})`).join('; ')) },
                        { key: 'why', header: t('govb1.evm.rows.why'), render: (row) => (row.missing.length === 0 ? '' : row.missing.map((code) => reasonText(t, code).reason).join('; ')) },
                      ]}
                    />
                  </SectionCard>
                </>
              )}
            </StateBoundary>
          )}

          {needsRef ? null : (
            <SectionCard
              title={t('govb1.evm.curve.title')}
              unit={t('govb1.evm.chart.unit')}
              actions={
                <span className="gov3-actions">
                  <button type="button" aria-pressed={showTable} data-testid="toggle-table" onClick={() => setShowTable((value) => !value)}>
                    {showTable ? t('govb1.evm.curve.hideTable') : t('govb1.evm.curve.showTable')}
                  </button>
                  <button
                    type="button"
                    data-testid="export"
                    disabled={exporter.isPending || curve.data === null || curve.data === undefined || curve.data === 'NO_BASELINE'}
                    onClick={() => {
                      if (projectId === undefined) return;
                      exporter.mutate(
                        { projectId, selection },
                        {
                          onSuccess: (file) => {
                            download(file);
                            setMessage({ tone: 'ok', text: t('govb1.evm.export.done', { name: file.fileName }) });
                          },
                          onError: (error) => setMessage({ tone: 'error', text: refusalText(t, describeRefusal(error)) }),
                        },
                      );
                    }}
                  >
                    {exporter.isPending ? t('govb1.common.sending') : t('govb1.evm.export')}
                  </button>
                </span>
              }
            >
              <StateBoundary state={curveState} onRetry={() => void curve.refetch()}>
                {curve.data === null || curve.data === undefined ? (
                  <p className="callout" data-testid="curve-missing">
                    {t('govb1.evm.missing')}
                  </p>
                ) : curve.data === 'NO_BASELINE' ? (
                  <div className="callout" data-testid="curve-no-baseline">
                    <p>{t('govb1.evm.curve.noBaseline')}</p>
                    <Link to={`/prj/prj-26?project=${projectId}`}>{t('govb1.evm.link.baseline')}</Link>
                  </div>
                ) : (
                  <>
                    <FlowChart series={series()} unit={t('govb1.evm.chart.unit')} caption={t('govb1.evm.chart.caption', { code: curve.data.projectCode })} state={curve.data.points.length === 0 ? 'empty' : 'ready'} />
                    <p className="muted" data-testid="chart-note">
                      {t('govb1.evm.chart.note', { count: curve.data.points.length })}
                    </p>
                    {showTable ? (
                      <DataTable
                        caption={t('govb1.evm.curve.table')}
                        rows={curve.data.points}
                        rowKey={(row) => row.day}
                        state={curve.data.points.length === 0 ? 'empty' : 'ready'}
                        columns={[
                          { key: 'day', header: t('govb1.evm.curve.day'), render: (row) => dayText(row.day) },
                          { key: 'pv0', header: t('govb1.evm.series.pvV0'), align: 'right', render: (row) => money(row.pvV0Vnd) },
                          { key: 'pvc', header: t('govb1.evm.series.pvCurrent'), align: 'right', render: (row) => money(row.pvCurrentVnd) },
                          { key: 'ev', header: t('govb1.evm.series.ev'), align: 'right', render: (row) => (row.evVnd === null ? t('govb1.common.na') : money(row.evVnd)) },
                          { key: 'ac', header: t('govb1.evm.series.ac'), align: 'right', render: (row) => (row.acVnd === null ? t('govb1.common.na') : money(row.acVnd)) },
                        ]}
                      />
                    ) : null}
                    <ReasonList codes={curve.data.missing} testId="curve-reasons" />
                  </>
                )}
              </StateBoundary>
            </SectionCard>
          )}

          <LinkPanel
            projectId={projectId}
            links={links}
            packages={packages}
            contracts={contracts}
            canLink={writable && (permissions === undefined || permissions.includes('project.evm.link'))}
            onDone={setMessage}
          />
        </>
      )}
      <p className="prototype-note">{t('govb1.evm.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function LinkPanel({
  projectId,
  links,
  packages,
  contracts,
  canLink,
  onDone,
}: {
  projectId: string;
  links: ReturnType<typeof useComponentContracts>;
  packages: Array<{ id: string; label: string }>;
  contracts: Array<{ id: string; label: string }>;
  canLink: boolean;
  onDone: (message: { tone: 'ok' | 'error'; text: string }) => void;
}) {
  const { t, locale } = useTranslation();
  const link = useLinkContract();
  const [picked, setPicked] = useState('');
  const [typed, setTyped] = useState('');
  const [componentId, setComponentId] = useState('');
  // A contract that is not linked yet is not in the list: its identifier may be typed.
  const contractId = typed.trim() === '' ? picked : typed.trim().toLowerCase();
  const valid = UUID.test(contractId);
  const state = useScreenState({ isLoading: links.isLoading, error: links.error, data: links.data, isEmpty: () => false });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    link.mutate(
      { projectId, body: { contract_id: contractId, component_id: componentId === '' ? null : componentId } },
      {
        onSuccess: () => onDone({ tone: 'ok', text: componentId === '' ? t('govb1.link.unlinked') : t('govb1.link.linked') }),
        onError: (error) => onDone({ tone: 'error', text: refusalText(t, describeRefusal(error)) }),
      },
    );
  };
  return (
    <SectionCard title={t('govb1.link.title')} unit={t('govb1.common.unit')}>
      <p className="muted">{t('govb1.link.rule')}</p>
      {state === 'denied' ? (
        <p className="callout" role="status" data-testid="links-denied">
          {t('govb1.link.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void links.refetch()}>
          <DataTable
            caption={t('govb1.link.title')}
            rows={links.data ?? []}
            rowKey={(row) => row.id}
            state={(links.data ?? []).length === 0 ? 'empty' : 'ready'}
            columns={[
              { key: 'contract', header: t('govb1.link.contract'), render: (row) => row.contractCode },
              { key: 'value', header: t('govb1.link.value'), align: 'right', render: (row) => vnd(row.contractValueVnd, locale) },
              { key: 'component', header: t('govb1.link.component'), render: (row) => row.componentCode ?? t('govb1.link.none') },
              { key: 'at', header: t('govb1.link.at'), render: (row) => asOfText(row.linkedAt) },
            ]}
          />
        </StateBoundary>
      )}
      {canLink && state !== 'denied' ? (
        <form onSubmit={submit} className="gov3-form" aria-label={t('govb1.link.form')}>
          <label>
            {t('govb1.link.contract')}
            <select value={picked} onChange={(event) => setPicked(event.target.value)} data-testid="link-contract">
              <option value="">{t('govb1.link.contract.choose')}</option>
              {contracts.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('govb1.link.contract.typed')}
            <input value={typed} onChange={(event) => setTyped(event.target.value)} data-testid="link-contract-id" aria-invalid={typed.trim() !== '' && !UUID.test(typed.trim())} />
          </label>
          <label>
            {t('govb1.link.component')}
            <select value={componentId} onChange={(event) => setComponentId(event.target.value)} data-testid="link-component">
              <option value="">{t('govb1.link.component.unlink')}</option>
              {packages.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!valid || link.isPending} data-testid="link-submit">
            {link.isPending ? t('govb1.common.sending') : componentId === '' ? t('govb1.link.unlink') : t('govb1.link.submit')}
          </button>
        </form>
      ) : null}
    </SectionCard>
  );
}
