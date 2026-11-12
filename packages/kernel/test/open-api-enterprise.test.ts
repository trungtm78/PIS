import { ENTERPRISE_BI_DATASETS, ENTERPRISE_BI_DATASET_DEFINITIONS, OPEN_DATASETS, OPEN_DATASET_DEFINITIONS, biDatasetFacts, biDatasetsOfEdition, isBiDatasetOfEdition, isOpenDataset } from '../src/index';

describe('the datasets of the enterprise edition (INT-2)', () => {
  it('offers the open datasets to the public edition and nothing more', () => {
    expect(biDatasetsOfEdition('public')).toEqual(['DS-DISB', 'DS-CTR']);
    expect(biDatasetsOfEdition('public')).toBe(OPEN_DATASETS);
    expect(isBiDatasetOfEdition('DS-ENT', 'public')).toBe(false);
    expect(isBiDatasetOfEdition('DS-DISB', 'public')).toBe(true);
  });

  it('adds the enterprise datasets for the enterprise edition', () => {
    expect(biDatasetsOfEdition('enterprise')).toEqual(['DS-DISB', 'DS-CTR', 'DS-ENT']);
    expect(isBiDatasetOfEdition('DS-ENT', 'enterprise')).toBe(true);
    expect(isBiDatasetOfEdition('DS-XYZ', 'enterprise')).toBe(false);
    expect(isBiDatasetOfEdition(undefined, 'enterprise')).toBe(false);
  });

  it('keeps the enterprise datasets out of the open ones, so the open API and its scopes never learn them', () => {
    for (const code of ENTERPRISE_BI_DATASETS) {
      expect(isOpenDataset(code)).toBe(false);
      expect(Object.keys(OPEN_DATASET_DEFINITIONS)).not.toContain(code);
    }
  });

  it('tells a reader what an open dataset is read through: one view and its scope', () => {
    const facts = biDatasetFacts('DS-CTR');
    expect(facts.scope).toBe(OPEN_DATASET_DEFINITIONS['DS-CTR'].scope);
    expect(facts.views).toEqual([{ view: 'v_contract_lines', grain: OPEN_DATASET_DEFINITIONS['DS-CTR'].grain, columns: OPEN_DATASET_DEFINITIONS['DS-CTR'].columns }]);
  });

  it('tells a reader what DS-ENT is read through: four views, no open API scope', () => {
    const facts = biDatasetFacts('DS-ENT');
    expect(facts.scope).toBe('');
    expect(facts.views.map((one) => one.view)).toEqual(['v_enterprise_figures', 'v_enterprise_plan_actual', 'v_enterprise_funding_split', 'v_enterprise_by_unit']);
  });

  it('documents every view with the tenant first, no repeated column and the day the certification ends last', () => {
    const seen = new Set<string>();
    for (const one of ENTERPRISE_BI_DATASET_DEFINITIONS['DS-ENT'].views) {
      expect(one.columns[0]).toBe('tenant_id');
      expect(one.columns.at(-1)).toBe('certification_expires_on');
      expect(new Set(one.columns).size).toBe(one.columns.length);
      expect(one.grain.length).toBeGreaterThan(20);
      expect(seen.has(one.view)).toBe(false);
      seen.add(one.view);
      // No view of the open datasets is named like one of these.
      expect(Object.values(OPEN_DATASET_DEFINITIONS).map((definition) => definition.view)).not.toContain(one.view);
    }
  });
});
