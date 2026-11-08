import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import base from '../../i18n/vi.json';
import CatalogueScreen from './CatalogueScreen';
import ConnectorScreen from './ConnectorScreen';
import IncidentScreen from './IncidentScreen';
import { ALL, agent, connector, detail, failing, harness, health, incident, list, mount, never, page, reject, routeOf, run, summary, uuid, waiting } from './test/support';

const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const fill = (key: string, params: Record<string, string | number>): string => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));
const problem = (code: string, status: number, detailText?: string) => new ApiError({ status, code, correlationId: 'c', ...(detailText === undefined ? {} : { detail: detailText }), extensions: {} } as never);
const REASON = 'Waiting for the official sample file';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

describe('HUB-01, the catalogue of connectors and the health of the hub', () => {
  const route = routeOf('HUB-01', 'FR-HUB-01');
  const answerWith = (items: unknown[], extra: Record<string, unknown> = {}) => (operation: string) => {
    if (operation === 'listHubConnectors') return list(items, extra);
    if (operation === 'getHubHealthSummary') return health();
    throw new Error(`unexpected read ${operation}`);
  };
  const mountCatalogue = (answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, permissions = ALL) => {
    const h = harness(answer, command);
    mount(<CatalogueScreen route={route} />, h, { permissions });
    return h;
  };

  it('AC-ST-HUB-001-5 / UI-HUB-01: lists every connector with direction, protocols, status, age and last run, and says what each waits for', async () => {
    mountCatalogue(answerWith([connector(), waiting(), failing()]));
    expect(await screen.findByTestId('connector-treasury.statement')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('hub.cat.page.title'));
    expect(screen.getByTestId('status-HEALTHY').textContent).toBe(word('hub.status.healthy'));
    expect(screen.getByTestId('status-PENDING_EXTERNAL').textContent).toBe(word('hub.status.pendingExternal'));
    expect(screen.getByTestId('status-FAILING').textContent).toBe(word('hub.status.failing'));
    expect(screen.getAllByTestId('acceptance-PENDING_EXTERNAL').length).toBe(3);
    expect(screen.getByText(word('hub.alert.connectorFailing'))).toBeTruthy();
    expect(screen.getByText(fill('hub.age.hours', { value: '10' }))).toBeTruthy();
    expect(screen.getByText(word('hub.age.none'))).toBeTruthy();
    expect(screen.getByText(word('hub.run.never'))).toBeTruthy();
  });

  it('shows the figures of the hub with the "i" of each: formula, source, as-of and the unverified flag', async () => {
    mountCatalogue(answerWith([connector(), waiting(), failing()]));
    await screen.findByTestId('connector-treasury.statement');
    const strip = screen.getByRole('group', { name: word('hub.cat.kpi.label') });
    expect(within(strip).getByText(word('hub.cat.kpi.healthy'))).toBeTruthy();
    expect(within(strip).getByText('50')).toBeTruthy();
    expect(within(strip).getByText(fill('hub.cat.kpi.healthy.sub', { of: '1/2' }))).toBeTruthy();
    const open = await within(strip).findByRole('button', { name: fill('hub.info.open', { name: 'Healthy share' }) });
    fireEvent.click(open);
    expect(screen.getByText('Formula of Healthy share')).toBeTruthy();
    expect(screen.getByText('Healthy connectors')).toBeTruthy();
    expect(screen.getByText(word('hub.info.unverified'))).toBeTruthy();
    expect(within(strip).getAllByRole('button', { name: /Formula and source|Công thức và nguồn/ }).length).toBe(5);
  });

  it('shows no percentage when nothing is monitored, never a false 100', async () => {
    mountCatalogue(answerWith([waiting()], { summary: summary({ total: 1, monitored: 0, healthy: 0, healthy_percent: null, oldest_data_age_hours: null, oldest_data_connector: null, failed_runs_7d: 0, discrepancy_backlog: 0, counts: { HEALTHY: 0, STALE: 0, FAILING: 0, DISABLED: 0, PENDING_EXTERNAL: 1, NEVER_RUN: 0 } }) }));
    await screen.findByTestId('connector-egp.muasamcong');
    const strip = screen.getByRole('group', { name: word('hub.cat.kpi.label') });
    expect(within(strip).queryByText('100')).toBeNull();
    expect(within(strip).getAllByText('–').length).toBeGreaterThan(0);
  });

  it('raises the hub-wide alert when many connectors are stale at once', async () => {
    mountCatalogue(answerWith([connector({ status: 'STALE' })], { summary: summary({ counts: { HEALTHY: 0, STALE: 2, FAILING: 0, DISABLED: 0, PENDING_EXTERNAL: 0, NEVER_RUN: 0 }, monitored: 2, hub_alert: { code: 'CONNECTOR_HUB_STALE', severity: 'URGENT' } }) }));
    expect((await screen.findByTestId('hub-alert')).textContent).toBe(fill('hub.cat.hubAlert', { stale: 2, monitored: 2 }));
  });

  it('sweeps the health on request and says so; a refusal is said in words', async () => {
    const h = mountCatalogue(answerWith([connector()]), () => ({ operation_id: 'x', status: 'OK', resource_version: 1, resource_id: uuid(1) }));
    await screen.findByTestId('connector-treasury.statement');
    fireEvent.click(screen.getByTestId('capture-snapshot'));
    expect((await screen.findByTestId('capture-receipt')).textContent).toBe(word('hub.cat.capture.done'));
    expect(h.command).toHaveBeenCalledWith('captureHubSnapshot', expect.objectContaining({ body: {} }));
  });

  it('says a refused sweep in words', async () => {
    mountCatalogue(answerWith([connector()]), () => problem('SCOPE_DENIED', 403));
    await screen.findByTestId('connector-treasury.statement');
    fireEvent.click(screen.getByTestId('capture-snapshot'));
    expect((await screen.findByTestId('capture-error')).textContent).toBe(word('hub.error.scope'));
  });

  it('shows the states: loading, empty, denied and error with a retry', async () => {
    const loading = mountCatalogue(() => never());
    expect(screen.queryByTestId('connector-treasury.statement')).toBeNull();
    loading.read.mockClear();
    cleanup();
    mountCatalogue(answerWith([]));
    await waitFor(() => expect(screen.queryByRole('status', { name: /./ })).toBeNull());
    cleanup();
    mountCatalogue(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mountCatalogue(() => problem('INTERNAL', 500));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('HUB-02, one connector', () => {
  const route = routeOf('HUB-02', 'FR-HUB-02');
  const readsOf = (over: Record<string, unknown> = {}, extra: (op: string) => unknown = () => undefined) => (operation: string) => {
    const special = extra(operation);
    if (special !== undefined) return special;
    switch (operation) {
      case 'getHubConnector':
        return detail(over);
      case 'listHubConnectorRuns':
        return page([run(1), run(2, { origin: 'HUB', outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', position: null })]);
      case 'listHubRejects':
        return page([reject(70)], { open_count: 1 });
      case 'listHubAgents':
        return { items: [agent(80)], stale_after_minutes: 15, as_of: '2026-11-08T03:00:00.000Z' };
      default:
        throw new Error(`unexpected read ${operation}`);
    }
  };
  const mountConnector = (answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, tab = 'overview', permissions = ALL) => {
    const h = harness(answer, command);
    mount(<ConnectorScreen route={route} />, h, { permissions, path: `/hub/hub-02?code=treasury.statement&tab=${tab}` });
    return h;
  };

  it('AC-ST-HUB-001-6 / UI-HUB-02: shows the overview with the status, the acceptance, the screens it owns and the alerts it can raise with owner, action and consequence', async () => {
    mountConnector(readsOf());
    expect(await screen.findByTestId('connector-head')).toBeTruthy();
    expect(screen.getByTestId('status-HEALTHY')).toBeTruthy();
    expect(screen.getByTestId('acceptance-PENDING_EXTERNAL')).toBeTruthy();
    expect(screen.getByTestId('screen-PAY-13').getAttribute('href')).toBe('/pay/pay-13');
    expect(screen.getByText('Open the connector and read the last failed run')).toBeTruthy();
    expect(screen.getByText('Figures stop at the last successful run')).toBeTruthy();
    expect(screen.getByText(word('hub.det.trend.empty'))).toBeTruthy();
  });

  it('switches the connector off only with a reason of ten characters, sends the version, and names the owner of the switch', async () => {
    const h = mountConnector(readsOf(), () => ({ operation_id: 'x', status: 'DISABLED', resource_version: 2, resource_id: 'treasury.statement' }));
    await screen.findByTestId('connector-head');
    expect(screen.getByText(word('hub.det.owner.hub'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('switch-state'));
    const confirm = await screen.findByRole('button', { name: word('hub.dlg.disable.confirm') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: REASON } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('setHubConnectorState', expect.objectContaining({ ifMatchVersion: 1, body: { enabled: false, reason: REASON } })));
  });

  it('says a stale version of the switch in words', async () => {
    mountConnector(readsOf(), () => problem('VERSION_CONFLICT', 409));
    await screen.findByTestId('connector-head');
    fireEvent.click(screen.getByTestId('switch-state'));
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('button', { name: word('hub.dlg.disable.confirm') }));
    expect(await screen.findByText(word('hub.error.versionConflict'))).toBeTruthy();
  });

  it('lists the runs from both sources with the error code of a failed one', async () => {
    mountConnector(readsOf(), undefined, 'runs');
    expect(await screen.findByText('IMPORT_SCHEMA_INVALID')).toBeTruthy();
    expect(screen.getAllByText(word('hub.runs.origin.hub')).length).toBe(1);
    expect(screen.getByText(`${word('hub.runs.origin.fileImport')} (TREASURY_STATEMENT_FILE)`)).toBeTruthy();
  });

  it('shows the pipeline: stages, schedule, watermark, the mapping in use, open rejects, and the protocols with their egress', async () => {
    mountConnector(readsOf(), undefined, 'pipeline');
    expect(await screen.findByText('STATEMENT file')).toBeTruthy();
    expect(screen.getByText(`${word('hub.pipe.stage.extract')} → ${word('hub.pipe.stage.validate')} → ${word('hub.pipe.stage.transform')} → ${word('hub.pipe.stage.load')}`)).toBeTruthy();
    expect(screen.getByText('2026-11.csv')).toBeTruthy();
    expect(screen.getByTestId('unmapped-STATEMENT').textContent).toBe(word('hub.pipe.mapping.none'));
    expect(screen.getByText(word('hub.pipe.schedule.manual'))).toBeTruthy();
    const drop = screen.getByTestId('protocol-FILE_DROP');
    expect(drop.textContent).toContain(word('hub.pipe.egress.none'));
    expect(drop.textContent).toContain(word('hub.pipe.impl.endToEnd'));
    const sftp = screen.getByTestId('protocol-SFTP');
    expect(sftp.textContent).toContain(word('hub.pipe.protocols.status.planned'));
    expect(sftp.textContent).toContain(word('hub.pipe.egress.allowlistedHost'));
    expect(await screen.findByText('REC-3')).toBeTruthy();
  });

  it('discards a reject with a reason and says when reprocessing is not wired', async () => {
    const h = mountConnector(readsOf(), (operation, input) => ((input as { body: { decision: string } }).body.decision === 'REPROCESS' ? problem('HUB_PIPELINE_NOT_WIRED', 409) : { operation_id: 'x', status: 'DISCARDED', resource_version: 2, resource_id: uuid(70) }), 'pipeline');
    fireEvent.click(await screen.findByTestId(`reprocess-${uuid(70)}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: 'Corrected at the source' } });
    fireEvent.click(screen.getByRole('button', { name: word('hub.rej.reprocess'), hidden: false }));
    expect(await screen.findByText(word('hub.error.notWired'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('hub.dialog.cancel') }));
    fireEvent.click(await screen.findByTestId(`discard-${uuid(70)}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: 'Not a record of ours' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.rej.discard') }).at(-1) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideHubReject', expect.objectContaining({ ifMatchVersion: 1, body: { decision: 'DISCARD', reason: 'Not a record of ours' } })));
  });

  it('shows the mapping versions and lets another person approve one; the proposer is refused in words', async () => {
    const h = mountConnector(readsOf(), () => problem('SELF_APPROVAL_DENIED', 403), 'mapping');
    expect(await screen.findByText(word('hub.map.state.proposed'))).toBeTruthy();
    fireEvent.click(screen.getByTestId(`approve-${uuid(60)}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: 'The columns match the register' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.map.approve') }).at(-1) as HTMLElement);
    expect(await screen.findByText(word('hub.error.selfApproval'))).toBeTruthy();
    expect(h.command).toHaveBeenCalledWith('decideHubMapping', expect.objectContaining({ ifMatchVersion: 1, body: { decision: 'APPROVE', reason: 'The columns match the register' } }));
  });

  it('proposes a mapping from a JSON array of fields and refuses text that is not one before any request', async () => {
    const h = mountConnector(readsOf(), () => ({ operation_id: 'x', status: 'PROPOSED', resource_version: 1, resource_id: uuid(61) }), 'mapping');
    fireEvent.click(await screen.findByTestId('propose-mapping'));
    fireEvent.change(await screen.findByTestId('propose-version'), { target: { value: 'M2' } });
    fireEvent.change(screen.getByTestId('propose-fields'), { target: { value: 'not json' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.map.propose') }).at(-1) as HTMLElement);
    expect(await screen.findByText(word('hub.dlg.propose.invalid'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('propose-fields'), { target: { value: '[{"source":"code","target":"project_code","required":true,"transform":{"kind":"UPPER"}}]' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.map.propose') }).at(-1) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('proposeHubMapping', expect.objectContaining({ body: expect.objectContaining({ pipeline_code: 'STATEMENT', mapping_version: 'M2' }) })));
  });

  it('shows the differences with a link into the screens the connector owns', async () => {
    mountConnector(readsOf(), undefined, 'differences');
    expect((await screen.findByTestId('diff-open')).textContent).toBe('2');
    expect(screen.getByRole('link', { name: 'PAY-13' }).getAttribute('href')).toBe('/pay/pay-13');
  });

  it('shows the credentials without any secret, and the collector agents with their platform and health from the heartbeat', async () => {
    mountConnector(readsOf(), undefined, 'credentials');
    expect(await screen.findByText(word('hub.cred.store.text'))).toBeTruthy();
    expect(screen.getByText(word('hub.cred.egress.none'))).toBeTruthy();
    expect(await screen.findByText('linux/arm64')).toBeTruthy();
    expect(screen.getByText(word('hub.agent.health.online'))).toBeTruthy();
    expect(screen.getByText(fill('hub.cred.agent.stale', { minutes: 15 }))).toBeTruthy();
  });

  it('shows the layouts with their acceptance and the freshness policy with its origin and the unverified flag', async () => {
    mountConnector(readsOf(), undefined, 'layouts');
    expect(await screen.findByText('ASSUMED-2026.1')).toBeTruthy();
    expect(screen.getByText('SAMPLE_STATEMENT')).toBeTruthy();
    expect(screen.getByText(word('hub.lay.origin.default'))).toBeTruthy();
    expect(screen.getByTestId('unverified')).toBeTruthy();
    expect(screen.getByText('Statement older than 36 hours warns')).toBeTruthy();
  });

  it('says a connector that has no freshness rule is not judged by age', async () => {
    mountConnector(readsOf({ freshness_rule: null }), undefined, 'layouts');
    expect(await screen.findByTestId('no-freshness')).toBeTruthy();
  });

  it('asks to choose a connector when the address names none', async () => {
    const h = harness(() => never());
    mount(<ConnectorScreen route={route} />, h, { permissions: ALL, path: '/hub/hub-02' });
    expect(screen.queryByTestId('connector-head')).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('HUB-03, the incident log', () => {
  const route = routeOf('HUB-03', 'FR-HUB-03');
  const reads = (items: unknown[]) => (operation: string) => {
    if (operation === 'listHubIncidents') return page(items);
    if (operation === 'listHubConnectors') return list([connector(), failing()]);
    throw new Error(`unexpected read ${operation}`);
  };
  const mountLog = (answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, path = '/hub/hub-03') => {
    const h = harness(answer, command);
    mount(<IncidentScreen route={route} />, h, { permissions: ALL, path });
    return h;
  };

  it('AC-ST-HUB-001-7 / UI-HUB-03: lists the incidents with kind, severity, state, who opened them, and the expected action and consequence of the alert behind each', async () => {
    mountLog(reads([incident(90), incident(91, { connector_code: null, kind: 'HUB_STALE', severity: 'URGENT' }), incident(92, { connector_code: 'treasury.statement', kind: 'MANUAL', summary: 'The file arrived with another layout', opened_by: uuid(801), alert: null })]));
    expect(await screen.findByTestId(`incident-${uuid(90)}`)).toBeTruthy();
    expect(screen.getAllByText(word('hub.inc.kind.failing')).length).toBeGreaterThan(0);
    expect(screen.getByText(word('hub.inc.hubWide'))).toBeTruthy();
    expect(screen.getByText('The file arrived with another layout')).toBeTruthy();
    expect(screen.getAllByText('Fix the cause and run again').length).toBe(2);
    expect(screen.getAllByText(word('hub.inc.byHub'), { exact: false }).length).toBeGreaterThan(0);
  });

  it('asks the hub for the state that was chosen and for the connector of the address', async () => {
    const h = mountLog(reads([incident(90)]), undefined, '/hub/hub-03?connector=procurement.milestones');
    await screen.findByTestId(`incident-${uuid(90)}`);
    expect(h.read).toHaveBeenCalledWith('listHubIncidents', expect.objectContaining({ query: expect.objectContaining({ connector_code: 'procurement.milestones' }) }));
    fireEvent.click(screen.getByTestId('filter-OPEN'));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listHubIncidents', expect.objectContaining({ query: expect.objectContaining({ state: 'OPEN', connector_code: 'procurement.milestones' }) })));
  });

  it('acknowledges an open incident with a reason and its version, and offers no step on a closed one', async () => {
    const h = mountLog(reads([incident(90), incident(91, { state: 'RESOLVED', resolved_at: '2026-11-08T02:00:00.000Z', resolution: 'CONDITION_CLEARED' })]), () => ({ operation_id: 'x', status: 'ACKNOWLEDGED', resource_version: 2, resource_id: uuid(90) }));
    fireEvent.click(await screen.findByTestId(`ack-${uuid(90)}`));
    expect(screen.queryByTestId(`ack-${uuid(91)}`)).toBeNull();
    expect(screen.queryByTestId(`resolve-${uuid(91)}`)).toBeNull();
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: 'I take it now' } });
    expect((screen.getAllByRole('button', { name: word('hub.inc.acknowledge') }).at(-1) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: 'I take it now, then fix it' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.inc.acknowledge') }).at(-1) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideHubIncident', expect.objectContaining({ ifMatchVersion: 1, body: { decision: 'ACKNOWLEDGE', reason: 'I take it now, then fix it' } })));
  });

  it('says a step on an incident that moved meanwhile in words', async () => {
    mountLog(reads([incident(90)]), () => problem('HUB_INCIDENT_STATE_INVALID', 409));
    fireEvent.click(await screen.findByTestId(`resolve-${uuid(90)}`));
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${word('hub.dialog.reason.label')}`)), { target: { value: 'The sender fixed the layout' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.inc.resolve') }).at(-1) as HTMLElement);
    expect(await screen.findByText(word('hub.error.incidentState'))).toBeTruthy();
  });

  it('reports an incident on a connector with a description of at least ten characters', async () => {
    const h = mountLog(reads([]), () => ({ operation_id: 'x', status: 'OPENED', resource_version: 1, resource_id: uuid(95) }));
    fireEvent.click(await screen.findByTestId('report-incident'));
    await screen.findByTestId('report-connector');
    fireEvent.change(screen.getByTestId('report-summary'), { target: { value: 'short' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.inc.report') }).at(-1) as HTMLElement);
    expect(await screen.findByText(fill('hub.inc.dlg.report.invalid', { min: 10 }))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('report-summary'), { target: { value: 'The file arrived with another layout' } });
    fireEvent.change(screen.getByTestId('report-severity'), { target: { value: 'WATCH' } });
    fireEvent.click(screen.getAllByRole('button', { name: word('hub.inc.report') }).at(-1) as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('openHubIncident', expect.objectContaining({ body: { connector_code: 'treasury.statement', summary: 'The file arrived with another layout', severity: 'WATCH' } })));
  });

  it('shows the empty state and the denied state', async () => {
    mountLog(reads([]));
    await waitFor(() => expect(screen.queryByTestId(`incident-${uuid(90)}`)).toBeNull());
    cleanup();
    mountLog(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

