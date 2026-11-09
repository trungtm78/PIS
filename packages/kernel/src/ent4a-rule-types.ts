import type { FieldSpec, RuleTypeInput } from './governance-rules.ts';
import { ENT4A_TEXT } from './messages/ent4a-texts.ts';
import { CROSSCHECK_DEFAULT_CODE, CROSSCHECK_ROLES, CROSSCHECK_SCALES, CROSSCHECK_RULE_IDS, CROSSCHECK_RULE_TYPE, CROSSCHECK_SEVERITIES, crosscheckDefaults, crosscheckDefect } from './report-crosscheck.ts';

/**
 * The kind of governance rule that lane ENT-4a adds (CN.04): the rule set of the cross-report comparison. This file holds only data; `registerEnt4aRules` in governance-rules.ts registers it. Every number is a
 * starting value that the customer confirms: UNVERIFIED, and every screen that shows one says so.
 */

const AS_OF = '2026-11-09';
const CODE = '^[A-Z][A-Z0-9_]{2,63}$';
const code: FieldSpec = { kind: 'text', max: 64, pattern: CODE };
const role: FieldSpec = { kind: 'enum', values: CROSSCHECK_ROLES };
const object = (fields: Record<string, FieldSpec>): FieldSpec => ({ kind: 'object', fields });
const optional = (spec: FieldSpec): FieldSpec => ({ ...spec, optional: true });

export const ent4aCrosscheckType = (): RuleTypeInput => ({
  type: CROSSCHECK_RULE_TYPE,
  ownerModule: 'RPT',
  modules: ['RPT', 'DIS'],
  formula: ENT4A_TEXT.type_formula,
  source: ENT4A_TEXT.type_source,
  asOf: AS_OF,
  legalStatus: 'UNVERIFIED',
  schema: {
    roles: { kind: 'list', of: object({ role, layout_code: { kind: 'text', max: 80, pattern: '^[A-Za-z0-9._-]{2,80}$' } }), min: 1, max: CROSSCHECK_ROLES.length },
    include_illustrative: { kind: 'boolean' },
    rate_codes: { kind: 'list', of: code, max: 40 },
    count_codes: { kind: 'list', of: code, max: 40 },
    total_code: code,
    row_source: object({
      key_column: { kind: 'text', max: 64 },
      unit_column: { kind: 'text', max: 64 },
      columns: { kind: 'list', of: object({ column: { kind: 'text', max: 64 }, code }), max: 60 },
    }),
    rate_defs: { kind: 'list', of: object({ code, numerator: code, denominator: code }), max: 40 },
    rules: {
      kind: 'list',
      of: object({
        id: { kind: 'enum', values: CROSSCHECK_RULE_IDS },
        enabled: { kind: 'boolean' },
        severity: { kind: 'enum', values: CROSSCHECK_SEVERITIES },
        codes: { kind: 'list', of: code, max: 60 },
        stock_codes: optional({ kind: 'list', of: code, max: 60 }),
        roles: optional({ kind: 'list', of: role, max: CROSSCHECK_ROLES.length }),
        pairs: optional({ kind: 'list', of: object({ left: role, right: role }), max: 12 }),
        absolute_vnd: { kind: 'int', min: 0, max: 1_000_000_000_000 },
        scale: { kind: 'enum', values: CROSSCHECK_SCALES },
        pct_tolerance: { kind: 'number', min: 0, max: 5 },
      }),
      min: 1,
      max: CROSSCHECK_RULE_IDS.length,
    },
  },
  refine: crosscheckDefect,
  defaults: { [CROSSCHECK_DEFAULT_CODE]: { params: crosscheckDefaults() } },
});
