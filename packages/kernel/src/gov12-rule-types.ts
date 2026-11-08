import type { FieldSpec, RuleTypeInput } from './governance-rules.ts';
import { AUDIT_STANDING_RULE_TYPE, auditStandingDefaults } from './audit-standing.ts';
import { message } from './messages.ts';
import { MONITORING_RULE_TYPE, monitoringDefaults, monitoringPolicyOf } from './monitoring-file.ts';
import { PERIOD_REPORT_RULE_TYPE, periodReportDefaults } from './period-report.ts';
import { PHOTO_INTEGRITY_RULE_TYPE, photoIntegrityDefaults } from './photo-findings.ts';
import { PORTAL_FIELDS, PORTAL_RULE_TYPE, portalDefaults } from './portal-fields.ts';
import { TRANSMITTAL_RULE_TYPE, transmittalDefaults } from './transmittal.ts';
import { GIFT_RULE_TYPE, WHISTLE_RULE_TYPE, giftDefaults, whistleDefaults } from './whistle.ts';

/**
 * The kinds of governance rule that lane GOV-12 adds (roadmap G4-6, G4-8, G4-9, G4-10, G4-11, G4-12). This file holds only data: the schema of each type, its built-in default with the source and the day it was taken,
 * and the legal status. `registerGov12Rules` in governance-rules.ts registers it. Every number is a starting value that the customer and the legal unit confirm: UNVERIFIED, and every screen that shows one says so.
 */

const AS_OF = '2026-11-08';
const SOURCE = (): string => message('gov.rules.gov12.source');
const int = (min: number, max: number): FieldSpec => ({ kind: 'int', min, max });
const oneOf = (...values: readonly string[]): FieldSpec => ({ kind: 'enum', values });
const money: FieldSpec = { kind: 'text', max: 24, pattern: '^[0-9]{1,24}$' };
const receiverList: FieldSpec = { kind: 'list', of: { kind: 'text', max: 60, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$' }, max: 20 };

const defaults = (value: object): Record<string, { params: Record<string, unknown> }> => ({ DEFAULT: { params: JSON.parse(JSON.stringify(value)) as Record<string, unknown> } });

export const gov12RuleTypes = (): RuleTypeInput[] => [
  {
    type: MONITORING_RULE_TYPE,
    ownerModule: 'PRJ',
    modules: ['PRJ', 'DOC', 'HOME'],
    formula: message('gov.rules.gov12.monitoring.formula'),
    source: message('gov.rules.gov12.monitoring.source'),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { notice_days: int(1, 365), response_days: int(1, 365), reminder_days: int(0, 60) },
    refine: (params) => {
      try {
        monitoringPolicyOf(params);
        return undefined;
      } catch {
        return 'reminder_days';
      }
    },
    defaults: defaults(monitoringDefaults()),
  },
  {
    type: TRANSMITTAL_RULE_TYPE,
    ownerModule: 'DOC',
    modules: ['DOC', 'PRJ', 'HOME'],
    formula: message('gov.rules.gov12.transmittal.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { review_days: int(1, 90), approval_days: int(1, 180), reminder_days: int(0, 30), max_extension_days: int(0, 90) },
    defaults: defaults(transmittalDefaults()),
  },
  {
    type: PORTAL_RULE_TYPE,
    ownerModule: 'PRJ',
    modules: ['PRJ', 'SAS'],
    formula: message('gov.rules.gov12.portal.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { allowed_fields: { kind: 'list', of: oneOf(...PORTAL_FIELDS), min: 1, max: PORTAL_FIELDS.length }, rate_per_minute: int(1, 6000), page_size_max: int(1, 500) },
    defaults: defaults(portalDefaults()),
  },
  {
    type: WHISTLE_RULE_TYPE,
    ownerModule: 'AUD',
    modules: ['AUD', 'HOME'],
    formula: message('gov.rules.gov12.whistle.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { acknowledge_days: int(1, 60), resolve_days: int(1, 730), rate_per_hour: int(1, 1000) },
    refine: (params) => ((params.acknowledge_days as number) >= (params.resolve_days as number) ? 'resolve_days' : undefined),
    defaults: defaults(whistleDefaults()),
  },
  {
    type: GIFT_RULE_TYPE,
    ownerModule: 'AUD',
    modules: ['AUD', 'HOME'],
    formula: message('gov.rules.gov12.gift.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { declare_within_days: int(0, 60), review_over_vnd: { kind: 'text', max: 18, pattern: '^[0-9]{1,18}$' }, keep_up_to_vnd: { kind: 'text', max: 18, pattern: '^[0-9]{1,18}$' } },
    refine: (params) => (BigInt(params.review_over_vnd as string) > BigInt(params.keep_up_to_vnd as string) ? 'keep_up_to_vnd' : undefined),
    defaults: defaults(giftDefaults()),
  },
  {
    type: PHOTO_INTEGRITY_RULE_TYPE,
    ownerModule: 'QMS',
    modules: ['QMS', 'AUD'],
    formula: message('gov.rules.gov12.photo.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { place_metres: int(1, 5000), moment_minutes: int(1, 1440) },
    defaults: defaults(photoIntegrityDefaults()),
  },
  {
    type: PERIOD_REPORT_RULE_TYPE,
    ownerModule: 'RPT',
    modules: ['RPT', 'DIS', 'DOC'],
    formula: message('gov.rules.gov12.period_report.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { signature_required_receivers: receiverList, lock_after: oneOf('SIGNED', 'ACCEPTED'), unlock_reason_min_chars: int(5, 500) },
    defaults: defaults(periodReportDefaults()),
  },
  {
    type: AUDIT_STANDING_RULE_TYPE,
    ownerModule: 'AUD',
    modules: ['AUD', 'DIS'],
    formula: message('gov.rules.gov12.audit_standing.formula'),
    source: SOURCE(),
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: { weight_overdue: int(0, 100), weight_disputed: int(0, 100), weight_open: int(0, 100), money_step_vnd: money, weight_money: int(0, 100) },
    defaults: defaults(auditStandingDefaults()),
  },
];
