import { builtInDefault, connectorConformanceProblems, connectorDescriptor, connectorOfPosition, registerAllGovernanceRules, runWithNetworkWatch } from '@machvon/kernel';
import { EBS_CONNECTION_DESCRIPTOR } from './ebs-connection.ts';
import { EBS_CONNECTOR_CODE, EBS_FILE_POSITION } from './ebs-rules.ts';
import { EBS_DESCRIPTOR, ENTERPRISE_CONNECTORS, HPM_DESCRIPTOR, HPM_FRESHNESS_RULE_CODE } from './hub-descriptors.ts';
import { HPM_CONNECTION_DESCRIPTOR } from './hpm-connection.ts';
import { HPM_CONNECTOR_CODE } from './hpm-rules.ts';
import { registerEnterpriseIntegrationRules } from './integration-rules.ts';

describe('the connectors of the enterprise edition in the Integration Hub', () => {
  beforeAll(() => {
    registerAllGovernanceRules();
    registerEnterpriseIntegrationRules();
  });

  it('are registered with the hub when the edition loads, and only then', () => {
    expect(connectorDescriptor(HPM_CONNECTOR_CODE)).toBe(HPM_DESCRIPTOR);
    expect(connectorDescriptor(EBS_CONNECTOR_CODE)).toBe(EBS_DESCRIPTOR);
    expect(connectorOfPosition(EBS_FILE_POSITION)).toBe(EBS_DESCRIPTOR);
    // A second load of the edition changes nothing.
    expect(() => registerEnterpriseIntegrationRules()).not.toThrow();
  });

  it('pass the conformance check of the hub and open no connection', async () => {
    for (const descriptor of ENTERPRISE_CONNECTORS) expect(connectorConformanceProblems(descriptor)).toEqual([]);
    const seen = await runWithNetworkWatch(async () => {
      for (const descriptor of ENTERPRISE_CONNECTORS) expect(connectorConformanceProblems(descriptor)).toEqual([]);
    });
    expect(seen).toEqual([]);
  });

  it('say what the connection descriptors and the rules say, number for number', () => {
    const hpm = HPM_DESCRIPTOR;
    expect(hpm.direction).toBe(HPM_CONNECTION_DESCRIPTOR.direction);
    expect(hpm.layouts.map((layout) => [layout.version, layout.acceptance])).toEqual(HPM_CONNECTION_DESCRIPTOR.layouts.map((layout) => [layout.version, layout.acceptance]));
    expect(hpm.alertTypes).toEqual([...HPM_CONNECTION_DESCRIPTOR.alertTypes]);
    expect(hpm.screens).toEqual([...HPM_CONNECTION_DESCRIPTOR.screens]);
    // The freshness code under CONNECTOR_FRESHNESS has the numbers of the rule HPM_PUSH_POLICY.
    const policy = builtInDefault(HPM_CONNECTION_DESCRIPTOR.freshness.ruleType, HPM_CONNECTION_DESCRIPTOR.freshness.ruleCode)?.params;
    const freshness = builtInDefault('CONNECTOR_FRESHNESS', HPM_FRESHNESS_RULE_CODE)?.params;
    expect(freshness).toEqual({ max_age_hours: policy?.max_age_hours, warn_after_hours: policy?.warn_after_hours, stale_severity: policy?.stale_severity, figures_blocked_when_stale: false });
    expect(freshness).toEqual({ max_age_hours: hpm.freshness?.defaults.maxAgeHours, warn_after_hours: hpm.freshness?.defaults.warnAfterHours, stale_severity: hpm.freshness?.defaults.staleSeverity, figures_blocked_when_stale: false });

    const ebs = EBS_DESCRIPTOR;
    expect(ebs.ledger.positions).toEqual([...EBS_CONNECTION_DESCRIPTOR.positions]);
    expect(ebs.layouts.map((layout) => [layout.version, layout.acceptance])).toEqual(EBS_CONNECTION_DESCRIPTOR.layouts.map((layout) => [layout.version, layout.acceptance]));
    expect(builtInDefault('CONNECTOR_FRESHNESS', ebs.freshness?.ruleCode ?? '')?.params).toEqual(EBS_CONNECTION_DESCRIPTOR.freshness.defaults);
    expect(ebs.screens).toEqual([...EBS_CONNECTION_DESCRIPTOR.screens]);
  });
});
