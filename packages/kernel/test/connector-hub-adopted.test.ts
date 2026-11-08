import {
  ACCESS_DESCRIPTOR,
  API_SERVE_PROTOCOL,
  BUILT_IN_CONNECTORS,
  FEED_KINDS,
  FEED_POSITIONS,
  FINANCE_FEED_CONNECTION,
  FINANCE_FEED_DESCRIPTOR,
  INDICATOR_IMPORT_CONNECTOR,
  INDICATOR_IMPORT_DESCRIPTOR,
  MASTER_IMPORT_DESCRIPTOR,
  ACCESS_CONNECTOR_CODE,
  OPEN_API_SCOPE_CODES,
  connectorAcceptance,
  connectorAlertTypes,
  connectorConformanceProblems,
  connectorDescriptor,
  connectorOfPosition,
  connectorTransports,
  protocolDefinition,
  registerAllGovernanceRules,
  registerBuiltInConnectors,
  runWithNetworkWatch,
} from '../src/index';
import { builtInDefault } from '../src/governance-rules';

/**
 * HUB-2: every connection that existed before the Integration Hub is a registered connector. The cases below hold the descriptors equal to what the modules that own the connections say, one connection at a time,
 * and give each descriptor the conformance check of the hub (the descriptor judges itself, the alert types and the freshness code exist, the sources open no network client).
 */
describe('the connections adopted by the Integration Hub', () => {
  beforeAll(() => {
    registerAllGovernanceRules();
    registerBuiltInConnectors();
  });

  const ADOPTED = [FINANCE_FEED_DESCRIPTOR, ACCESS_DESCRIPTOR, INDICATOR_IMPORT_DESCRIPTOR, MASTER_IMPORT_DESCRIPTOR];

  it('registers each of them and passes the conformance check of the hub', () => {
    for (const descriptor of ADOPTED) {
      expect(BUILT_IN_CONNECTORS).toContain(descriptor);
      expect(connectorDescriptor(descriptor.code)).toBe(descriptor);
      expect(connectorConformanceProblems(descriptor)).toEqual([]);
    }
  });

  it('covers every connection that has a position in the file import framework or a connector code of its own', () => {
    const codes = BUILT_IN_CONNECTORS.map((descriptor) => descriptor.code);
    expect(codes).toEqual(expect.arrayContaining(['egp.muasamcong', 'treasury.statement', 'national.project_codes', 'procurement.milestones', 'fin.sotaichinh', 'access.open-api', 'ind.figure-import', 'mdm.catalogue-import']));
    expect(new Set(codes).size).toBe(codes.length);
    for (const position of [...Object.values(FEED_POSITIONS), INDICATOR_IMPORT_CONNECTOR, 'TREASURY_STATEMENT_FILE', 'NATIONAL_PIM_FILE', 'PROCUREMENT_FILE', 'EGP_KHLCNT_FILE']) {
      expect(connectorOfPosition(position)).toBeDefined();
    }
  });

  it('says for the Finance Department feed what the module of the feed says', () => {
    const d = FINANCE_FEED_DESCRIPTOR;
    expect(d.code).toBe(FINANCE_FEED_CONNECTION.code);
    expect(d.direction).toBe(FINANCE_FEED_CONNECTION.direction);
    expect(d.ledger.positions).toEqual(FEED_KINDS.map((kind) => FEED_POSITIONS[kind]));
    expect(d.layouts.map((layout) => layout.code)).toEqual([...FEED_KINDS]);
    expect(d.layouts.every((layout) => layout.version === FINANCE_FEED_CONNECTION.layouts.current && layout.acceptance === 'PENDING_EXTERNAL')).toBe(true);
    expect(connectorAcceptance(d)).toBe(FINANCE_FEED_CONNECTION.layouts.acceptance);
    expect(d.alertTypes).toEqual([...FINANCE_FEED_CONNECTION.alertTypes]);
    expect(d.ownerRole).toBe(FINANCE_FEED_CONNECTION.ownerRole);
    expect(d.egress.policy).toBe(FINANCE_FEED_CONNECTION.egressPolicy);
    expect(d.screens).toEqual([...FINANCE_FEED_CONNECTION.screens]);
    expect(d.ledger.stateOwner).toBe('CONNECTOR');
    // The freshness defaults of the descriptor are the built-in rule, number for number.
    const rule = builtInDefault('CONNECTOR_FRESHNESS', FINANCE_FEED_CONNECTION.freshness.ruleCode);
    expect(rule?.params).toEqual({ max_age_hours: d.freshness?.defaults.maxAgeHours, warn_after_hours: d.freshness?.defaults.warnAfterHours, stale_severity: d.freshness?.defaults.staleSeverity, figures_blocked_when_stale: d.freshness?.defaults.figuresBlockedWhenStale });
    // The feed also raises the alert types of the base hub besides its own three.
    expect(connectorAlertTypes(d)).toEqual(expect.arrayContaining(['CONNECTOR_FAILING', 'CONNECTOR_STALE', 'FEED_STALE', 'FEED_UNIT_LATE', 'FEED_DISCREPANCY_LARGE']));
    for (const code of d.alertTypes) expect(builtInDefault('ALERT_TYPE', code)?.params.owner).toBeDefined();
  });

  it('describes the open interface as a served interface whose credentials are machine accounts and whose scopes are the open scopes', () => {
    const d = ACCESS_DESCRIPTOR;
    expect(d.code).toBe(ACCESS_CONNECTOR_CODE);
    expect(d.protocols).toEqual([API_SERVE_PROTOCOL]);
    expect(protocolDefinition(API_SERVE_PROTOCOL)?.egress).toBe('NONE');
    expect(connectorTransports(d)).toEqual(['API_PULL']);
    expect(d.credentials).toEqual({ kind: 'MACHINE_ACCOUNT', scopes: OPEN_API_SCOPE_CODES });
    expect(d.freshness).toBeNull();
    expect(d.egress.policy).toBe('NONE');
    expect(d.layouts).toEqual([]);
    expect(connectorAlertTypes(d)).toEqual(['CONNECTOR_FAILING']);
  });

  it('describes the two imports whose layout is the tenant mapping: no outside acceptance to wait for', () => {
    for (const d of [INDICATOR_IMPORT_DESCRIPTOR, MASTER_IMPORT_DESCRIPTOR]) {
      expect(d.layouts.every((layout) => layout.acceptance === 'NOT_APPLICABLE')).toBe(true);
      expect(connectorAcceptance(d)).toBe('NOT_APPLICABLE');
      expect(d.direction).toBe('INBOUND');
      expect(d.pipelines?.map((pipeline) => pipeline.layoutCode)).toEqual(d.layouts.map((layout) => layout.code));
    }
    expect(INDICATOR_IMPORT_DESCRIPTOR.ledger).toMatchObject({ kind: 'FILE_FRAMEWORK', positions: [INDICATOR_IMPORT_CONNECTOR], cursorless: true });
    expect(MASTER_IMPORT_DESCRIPTOR.ledger).toMatchObject({ kind: 'HUB_RUNS', positions: [] });
  });

  it('opens no network connection when a conformance run walks the egress-free sources', async () => {
    const seen = await runWithNetworkWatch(async () => {
      for (const descriptor of ADOPTED) expect(connectorConformanceProblems(descriptor)).toEqual([]);
    });
    expect(seen).toEqual([]);
  });

  it('refuses a conformance run on a descriptor whose source file does not exist', () => {
    const broken = { ...MASTER_IMPORT_DESCRIPTOR, sources: ['packages/db/src/no-such-file.ts'] };
    expect(connectorConformanceProblems(broken, { requireRegistered: false })).toEqual(['source: packages/db/src/no-such-file.ts does not exist']);
  });
});
