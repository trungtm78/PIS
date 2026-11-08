import { builtInDefault } from '@machvon/kernel';
import { EBS_CONNECTION_DESCRIPTOR } from './ebs-connection.ts';
import { EBS_ADAPTER_STATUS, EBS_CONNECTOR_CODE, EBS_FILE_POSITION, EBS_LAYOUT_VERSION, ebsAcceptance } from './ebs-rules.ts';
import { HPM_CONNECTION_DESCRIPTOR } from './hpm-connection.ts';
import { HPM_ADAPTER_STATUS, HPM_ALERT_CODES, HPM_CONNECTOR_CODE, HPM_PACKAGE_FORMAT, hpmAcceptance } from './hpm-rules.ts';
import { registerEnterpriseIntegrationRules } from './integration-rules.ts';

describe('the descriptors the Integration Hub reads', () => {
  beforeAll(() => registerEnterpriseIntegrationRules());

  it('say what the rules of the connection say, for HPM', () => {
    const d = HPM_CONNECTION_DESCRIPTOR;
    expect(d.code).toBe(HPM_CONNECTOR_CODE);
    expect(d.adapterStatus).toBe(HPM_ADAPTER_STATUS);
    expect(d.layouts[0]?.version).toBe(HPM_PACKAGE_FORMAT);
    expect(d.layouts[0]?.acceptance).toBe(hpmAcceptance(HPM_PACKAGE_FORMAT));
    expect([...d.alertTypes]).toEqual([...HPM_ALERT_CODES]);
    expect(builtInDefault(d.freshness.ruleType, d.freshness.ruleCode)?.params).toEqual(d.freshness.defaults);
    for (const code of d.alertTypes) expect(builtInDefault('ALERT_TYPE', code)?.params.owner).toBe(d.ownerRole);
    expect(d.egressPolicy).toBe('NONE');
    expect(d.transportModes).toEqual(['FILE_EXPORT']);
  });

  it('say what the rules of the connection say, for Oracle EBS', () => {
    const d = EBS_CONNECTION_DESCRIPTOR;
    expect(d.code).toBe(EBS_CONNECTOR_CODE);
    expect(d.adapterStatus).toBe(EBS_ADAPTER_STATUS);
    expect([...d.positions]).toEqual([EBS_FILE_POSITION]);
    expect(d.layouts[0]?.version).toBe(EBS_LAYOUT_VERSION);
    expect(d.layouts[0]?.acceptance).toBe(ebsAcceptance(EBS_LAYOUT_VERSION));
    expect(builtInDefault(d.freshness.ruleType, d.freshness.ruleCode)?.params).toEqual(d.freshness.defaults);
    expect(builtInDefault(d.reconcilePolicy.ruleType, d.reconcilePolicy.ruleCode)?.params).toEqual(d.reconcilePolicy.defaults);
    for (const code of d.alertTypes) expect(builtInDefault('ALERT_TYPE', code)?.params.owner).toBe(d.ownerRole);
    expect(d.egressPolicy).toBe('NONE');
    expect(d.transportModes).toEqual(['FILE_IMPORT']);
  });
});
