import { describe, expect, it } from 'vitest';
import en from '../../../i18n/en.json';
import {
  featureLabel,
  fieldProblemMessage,
  governingBodyLabel,
  isolationLabel,
  licenseLabel,
  modeLabel,
  modeTone,
  problemMessage,
  regionLabel,
  runStatusLabel,
  sourceLabel,
  statusLabel,
  statusTone,
  stepLabel,
  toneClass,
} from './labels';
import type { ProblemView } from './problems';
import type { FieldProblem } from './rules';
import { GOVERNING_BODY_TYPES, REGIONS, TENANT_STATUSES } from './types';

/** A translator that answers the key, so a test sees which key a label asks for and that the catalogue holds it. */
const t = (key: string): string => key;
const known = (key: string): boolean => key in en;

const STEPS = ['IDP_ORG', 'DNS_SUBDOMAIN', 'STORAGE_PREFIX', 'DB_PLACEMENT', 'RLS_SEED', 'ENTITLEMENT_V1', 'LICENSE_PILOT', 'ROLE_SEED', 'ROOT_UNIT', 'THEME_V1', 'OWNER_INVITE'];
const RUN_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'COMPENSATED'];
const FIELD_PROBLEMS: FieldProblem[] = ['required', 'pattern', 'tooShort', 'tooLong', 'email', 'uuid', 'choice'];
const REASONS: ProblemView['reason'][] = ['codeTaken', 'domainTaken', 'planNotPublished', 'placementUnavailable', 'invalid', 'fieldNotAllowed', 'stateInvalid', 'conflict', 'notFound', 'denied', 'stepUp', 'session', 'offline', 'general'];
const FEATURES = ['reporting', 'export', 'ai.analysis', 'notification.campaign', 'member.invite'];
const MODES = ['FULL', 'READ_ONLY', 'EXPORT_ONLY', 'DENIED'];
const LICENSES = ['FULL', 'GRACE', 'EXPIRED', 'SUSPENDED', 'REVOKED'];

describe('labels of the control-plane screens', () => {
  it('asks for a catalogue key for every known value and gives each value its own label', () => {
    const groups: [string, string[]][] = [
      ['status', TENANT_STATUSES.map((status) => statusLabel(t, status))],
      ['step', STEPS.map((step) => stepLabel(t, step))],
      ['run status', RUN_STATUSES.map((status) => runStatusLabel(t, status))],
      ['isolation', ['POOL', 'SILO'].map((mode) => isolationLabel(t, mode))],
      ['region', REGIONS.map((region) => regionLabel(t, region))],
      ['governing body', GOVERNING_BODY_TYPES.map((type) => governingBodyLabel(t, type))],
      ['field problem', FIELD_PROBLEMS.map((problem) => fieldProblemMessage(t, problem))],
      ['problem', REASONS.map((reason) => problemMessage(t, { reason, field: undefined, currentVersion: undefined }))],
      ['feature', FEATURES.map((feature) => featureLabel(t, feature))],
      ['mode', MODES.map((mode) => modeLabel(t, mode))],
      ['source', ['PLAN', 'OVERRIDE'].map((source) => sourceLabel(t, source))],
      ['licence', LICENSES.map((license) => licenseLabel(t, license))],
    ];
    for (const [name, labels] of groups) {
      expect(new Set(labels).size, `${name} labels are distinct`).toBe(labels.length);
      for (const label of labels) expect(known(label), `${name}: ${label} is in the catalogue`).toBe(true);
    }
  });

  it('shows a value it does not know as it was written, or a dash for a missing one', () => {
    expect(statusLabel(t, 'Mystery')).toBe('Mystery');
    expect(stepLabel(t, 'NEW_STEP')).toBe('NEW_STEP');
    expect(runStatusLabel(t, 'PAUSED')).toBe('PAUSED');
    expect(isolationLabel(t, 'BRIDGE')).toBe('BRIDGE');
    expect(isolationLabel(t, undefined)).toBe('sas.tenants.none');
    expect(featureLabel(t, 'new.feature')).toBe('new.feature');
    expect(modeLabel(t, 'PAUSED')).toBe('PAUSED');
    expect(licenseLabel(t, 'ODD')).toBe('ODD');
    expect(licenseLabel(t, undefined)).toBe('sas.tenants.none');
  });

  it('names the current version in the stale-version message', () => {
    expect(problemMessage((key, values) => `${key}:${String(values?.version)}`, { reason: 'conflict', field: undefined, currentVersion: 7 })).toBe('sas.tenantCreate.error.conflict:7');
  });

  it('picks the tone of a status and of an entitlement mode', () => {
    expect(['Active', 'Failed', 'Requested', 'Provisioning', 'Suspended', 'Offboarding', 'Archived'].map((status) => statusTone(status))).toEqual(['ok', 'red', 'warn', 'warn', 'warn', 'warn', 'gray']);
    expect(statusTone('Mystery')).toBe('gray');
    expect(toneClass('ok')).toBe('pill');
    expect(toneClass('red')).toBe('pill red');
    expect([modeTone('FULL'), modeTone('DENIED'), modeTone('READ_ONLY')]).toEqual(['ok', 'red', 'warn']);
  });
});
