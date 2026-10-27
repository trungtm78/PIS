export const field = (name: string) => ({ op: 'field', name });
export const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
export const ID = '00000000-0000-4000-8000-0000000000a1';
export const DATASET = '00000000-0000-4000-8000-0000000000d1';

export const rawMetric = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  code: 'disbursement_rate',
  revision: 1,
  grain: 'project',
  aggregation_type: 'ratio',
  expression_ast: { op: 'div', args: [sum('GIAI_NGAN'), sum('KE_HOACH_TTG')] },
  numerator_ast: sum('GIAI_NGAN'),
  denominator_ast: sum('KE_HOACH_TTG'),
  unit: 'percent',
  owner_id: '00000000-0000-4000-8000-0000000000b1',
  status: 'CERTIFIED',
  origin: 'PLATFORM_CODE',
  source_commit: 'c1a2b3c',
  definition_sha256: 'a'.repeat(64),
  null_policy: 'NULL_NOT_ZERO',
  dimension_codes: ['unit'],
  dataset_id: null,
  glossary_term_id: null,
  effective_from: '2026-01-01',
  effective_until: null,
  certified_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  created_by: '00000000-0000-4000-8000-0000000000b1',
  ...overrides,
});
