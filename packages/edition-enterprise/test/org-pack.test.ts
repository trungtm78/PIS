import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS } from '@machvon/contracts';
import { validateMasterContent } from '@machvon/db';
import type { EntryRef, MasterContent } from '@machvon/db';
import {
  ORG_PACK_MAPPING,
  absencePolicyOf,
  directoryMappings,
  enterprisePackParams,
  judgeMigrationFile,
  judgeOrgPack,
  judgeOrgPackRows,
  orgPackCsv,
  orgPackDigest,
  orgPackOfRows,
  orgPackRows,
  readTabularFile,
  verifyOrgPack,
} from '@machvon/kernel';
import type { OrgPackState } from '@machvon/kernel';
import {
  ADMIN_UNIT,
  INPUT_POINT_CODES,
  LEADERSHIP_UNIT_CODES,
  PLANNING_UNIT,
  PVFCCO_DIRECTORY_PREFIX,
  PVFCCO_PACK_LABEL,
  ROLE_ADMIN,
  ROLE_APPROVER,
  ROLE_ENTRY,
  ROLE_PLANNER,
  ROLE_VIEWER,
  ROOT_UNIT,
  pvfccoTemplatePack,
} from '../src/org-pack/pvfcco-template.ts';

const pack = pvfccoTemplatePack();
const KNOWN = new Set<string>(Object.values(PERMISSIONS));

describe('the PVFCCo template pack (HT.02, HT.03, MD.03, QT.01)', () => {
  it('is a pack the kernel accepts, labelled as a template', () => {
    expect(judgeOrgPack(pack)).toEqual([]);
    expect(pack.label).toBe(PVFCCO_PACK_LABEL);
    expect(pack.label).toBe('PVFCCO-TEMPLATE');
    expect(orgPackRows(pack).every((row) => row.pack === 'PVFCCO-TEMPLATE')).toBe(true);
  });

  it('has the nine input points of the spec, the two project teams as placeholders, one aggregating board, two leadership bodies and one administration', () => {
    const points = pack.units.filter((unit) => unit.function === 'INPUT_POINT');
    expect(points.map((unit) => unit.code)).toEqual([...INPUT_POINT_CODES]);
    expect(points).toHaveLength(9);
    expect(points.filter((unit) => unit.placeholder).map((unit) => unit.name)).toEqual(['[tên Tổ dự án 1]', '[tên Tổ dự án 2]']);
    expect(pack.units.filter((unit) => unit.function === 'AGGREGATOR').map((unit) => unit.code)).toEqual([PLANNING_UNIT]);
    expect(pack.units.filter((unit) => unit.function === 'LEADERSHIP').map((unit) => unit.code)).toEqual([...LEADERSHIP_UNIT_CODES]);
    expect(pack.units.filter((unit) => unit.function === 'ADMINISTRATION').map((unit) => unit.code)).toEqual([ADMIN_UNIT]);
    expect(pack.units.filter((unit) => unit.function !== 'ROOT').every((unit) => unit.parentCode === ROOT_UNIT)).toBe(true);
    expect(pack.units.find((unit) => unit.code === 'NM_DPM')?.name).toBe('Nhà máy Đạm Phú Mỹ');
    expect(pack.units.find((unit) => unit.code === 'KHDT')?.name).toBe('Ban Kế hoạch và Đầu tư');
  });

  it('gives each input point one person to enter and one to approve, for the unit alone; the planning unit and the leadership see all (HT.02)', () => {
    for (const code of INPUT_POINT_CODES) {
      const seats = pack.seats.filter((seat) => seat.unitCode === code);
      expect(seats.map((seat) => [seat.roleCode, seat.scope, seat.minHolders, seat.maxHolders])).toEqual([
        [ROLE_ENTRY, 'UNIT_ONLY', 1, 1],
        [ROLE_APPROVER, 'UNIT_ONLY', 1, 1],
      ]);
    }
    const wide = pack.seats.filter((seat) => seat.scope === 'TENANT');
    expect(new Set(wide.map((seat) => seat.roleCode))).toEqual(new Set([ROLE_PLANNER, ROLE_VIEWER, ROLE_ADMIN]));
    expect(wide.find((seat) => seat.roleCode === ROLE_PLANNER)).toMatchObject({ unitCode: PLANNING_UNIT, minHolders: 2 });
    expect(pack.seats).toHaveLength(9 * 2 + 1 + 2 + 1);
  });

  it('chains the approval as the minutes 43/BBH-KHDT say, each step with a deadline', () => {
    expect(pack.steps.map((step) => step.kind)).toEqual(['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH']);
    expect(pack.steps.every((step) => step.slaWorkingHours >= 1)).toBe(true);
    expect(pack.steps[0]?.assignee).toBe('DOA');
    expect(pack.steps.slice(1).every((step) => step.roleCode === ROLE_PLANNER && step.unitCode === PLANNING_UNIT)).toBe(true);
    expect(pack.doa).toMatchObject({ documentType: 'REPORT_ACCEPT', unitCode: ROOT_UNIT, roleCode: ROLE_APPROVER });
  });

  it('holds only permissions that the contract has, and gives leadership nothing but reads', () => {
    const missing = pack.roles.flatMap((role) => role.permissions.filter((name) => !KNOWN.has(name) && !name.endsWith('.*')).map((name) => `${role.code}:${name}`));
    expect(missing).toEqual([]);
    const viewer = pack.roles.find((role) => role.code === ROLE_VIEWER);
    expect(viewer?.permissions.every((name) => /\.(read|query)$/.test(name))).toBe(true);
    expect(pack.roles.every((role) => role.rank < 90 && role.permissions.every((name) => !name.startsWith('system.')))).toBe(true);
  });

  it('can hand entry and approval over (HT.03) and covers an absent approver by the policy the platform accepts', () => {
    expect(pack.delegation.delegableRoles).toEqual([ROLE_ENTRY, ROLE_APPROVER]);
    for (const code of pack.delegation.delegableRoles) expect(pack.roles.find((role) => role.code === code)?.permissions).toContain('iam.delegation.create');
    expect(absencePolicyOf(pack.absence).min_role_holders).toBe(1);
  });

  it('contains no person, no account and no secret', () => {
    const csv = orgPackCsv(pack);
    expect(csv).not.toMatch(/@[A-Za-z0-9-]+\.[a-z]{2,}/);
    expect(csv).not.toMatch(/membership_ids|password|secret|token/i);
    expect(pack.seats.every((seat) => Object.keys(seat).sort().join() === 'maxHolders,minHolders,roleCode,scope,unitCode')).toBe(true);
  });

  it('is the file that is committed for the administrators to register (npm run org-pack:build when the pack changes)', () => {
    const committed = readFileSync(join(__dirname, '..', 'templates', 'org-pack', 'pvfcco-template.csv'), 'utf8');
    expect(committed).toBe(orgPackCsv(pack));
  });

  it('is a file the real import path reads without a complaint, whose rows give the pack back and whose digest is stable', () => {
    const table = readTabularFile(new TextEncoder().encode(orgPackCsv(pack)));
    const judged = judgeMigrationFile(table, ORG_PACK_MAPPING);
    expect(judged.errors).toEqual([]);
    expect(judged.rowCount).toBe(orgPackRows(pack).length);
    const rows = judged.rows.map((row) => ({ rowNumber: row.rowNumber, businessKey: row.businessKey, payload: row.payload }));
    expect(judgeOrgPackRows(rows)).toEqual([]);
    expect(orgPackOfRows(rows).pack).toEqual(pack);
    expect(orgPackDigest(pvfccoTemplatePack())).toBe(orgPackDigest(pack));
    expect(orgPackCsv(pvfccoTemplatePack())).toBe(orgPackCsv(pack));
  });

  describe('the catalogues of MD.03', () => {
    const asEntry = (item: (typeof pack.entries)[number]): EntryRef => ({ masterType: item.masterType, businessKey: item.key, attributes: item.attributes });
    const lookup = { entry: (masterType: string, businessKey: string) => Promise.resolve(pack.entries.filter((item) => item.masterType === masterType && item.key === businessKey).map(asEntry)[0]) };

    it('passes the rules of its types, parents first', async () => {
      for (const item of pack.entries) {
        const parent = item.parentKey === null ? undefined : pack.entries.find((candidate) => candidate.masterType === item.masterType && candidate.key === item.parentKey);
        const content: MasterContent = { label: item.label, attributes: item.attributes, parentRecordId: null, validFrom: '2026-01-01', validUntil: null, legalBasis: null };
        await expect(validateMasterContent({ masterType: item.masterType, businessKey: item.key, content, parent: parent === undefined ? undefined : asEntry(parent), lookup })).resolves.toBeUndefined();
      }
    });

    it('covers what MD.03 lists: report types, receiving agencies, periods, funding sources, units of measure and the delay causes of MDM-17', () => {
      const keys = (type: string): string[] => pack.entries.filter((item) => item.masterType === type).map((item) => item.key);
      expect(keys('REPORTING_PERIOD_KIND')).toEqual(['MONTH', 'QUARTER', 'YEAR', 'MEETING']);
      expect(keys('RECEIVING_AGENCY')).toEqual(['PVN', 'HPM', 'UB_DTPT_KHCN', 'SO_BAN_NGANH', 'GIAO_BAN']);
      expect(keys('REPORT_TYPE').length).toBeGreaterThanOrEqual(6);
      expect(keys('CAPITAL_SOURCE')).toEqual(['EQUITY', 'LOAN', 'OTHER']);
      expect(keys('REPORT_UNIT')).toEqual(expect.arrayContaining(['VND', 'MILLION_VND', 'BILLION_VND', 'PERCENT']));
      const causes = pack.entries.filter((item) => item.masterType === 'ISSUE_CATEGORY');
      expect(causes.filter((item) => item.parentKey === null).map((item) => item.key)).toEqual(['DELAY_CAUSE']);
      expect(causes.length).toBeGreaterThanOrEqual(8);
      for (const cause of causes) expect(pack.units.map((unit) => unit.code)).toContain(cause.attributes.handler_unit_key);
    });

    it('names the classes of the funding pack of the enterprise edition and only those', () => {
      const classes = (enterprisePackParams().classes as Array<{ code: string }>).map((one) => one.code).sort();
      const sources = pack.entries.filter((item) => item.masterType === 'CAPITAL_SOURCE').map((item) => item.attributes.fnd_class_code as string).sort();
      expect(sources).toEqual(classes);
    });

    it('sends every report type of every agency to a report type that exists, and every form code to a form of the demo catalogue', () => {
      const types = new Set(pack.entries.filter((item) => item.masterType === 'REPORT_TYPE').map((item) => item.key));
      for (const agency of pack.entries.filter((item) => item.masterType === 'RECEIVING_AGENCY')) for (const key of agency.attributes.report_type_keys as string[]) expect(types.has(key)).toBe(true);
      const forms = ['PVN-MONTHLY', 'PVN-QUARTERLY-F2', 'HPM-MONTHLY', 'COMMITTEE-PERIODIC', 'INVEST-STEERING', 'PLANT-PHU-MY'];
      for (const item of pack.entries.filter((candidate) => candidate.masterType === 'REPORT_TYPE' && candidate.attributes.form_code !== undefined)) expect(forms).toContain(item.attributes.form_code);
    });
  });

  describe('the directory groups', () => {
    it('are one for each seat, inside the MACHVON filter, and read from the pack', () => {
      const mappings = directoryMappings(pack);
      expect(mappings).toHaveLength(pack.seats.length);
      expect(mappings.every((one) => one.adGroup.startsWith(`${PVFCCO_DIRECTORY_PREFIX}-`) && one.adGroup.length <= 64)).toBe(true);
      expect(mappings.map((one) => one.adGroup)).toEqual(expect.arrayContaining(['MACHVON-PVFCCO-NM-DPM-ENTRY', 'MACHVON-PVFCCO-NM-DPM-APPROVER', 'MACHVON-PVFCCO-KHDT-REVIEW', 'MACHVON-PVFCCO-BTGD-LEADER', 'MACHVON-PVFCCO-HDQT-LEADER', 'MACHVON-PVFCCO-CDS-CNTT-ADMIN']));
    });

    it('are the groups of infra/keycloak/onprem/ad-group-role-map.json, whose tenantMappings are made from this pack', () => {
      const map = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'infra', 'keycloak', 'onprem', 'ad-group-role-map.json'), 'utf8')) as { tenantMappings: unknown };
      expect(map.tenantMappings).toEqual(
        directoryMappings(pack).map((one) => ({ adGroup: one.adGroup, tenantRole: one.tenantRole, scopeKind: one.scopeKind, unit: one.unit, pack: PVFCCO_PACK_LABEL })),
      );
    });
  });

  it('reports a tenant that has nothing as all to create, and the seats as vacant', () => {
    const empty: OrgPackState = { units: new Map(), roles: new Map(), workflowVersions: [], absenceVersions: [], doa: 'NONE', entries: new Map(), holders: new Map() };
    const report = verifyOrgPack(pack, empty);
    expect(report.counts.UNCHANGED).toBe(0);
    expect(report.counts.CREATE).toBe(report.items.length);
    expect(report.seatCounts).toEqual({ VACANT: pack.seats.length, FILLED: 0, OVER: 0 });
    expect(report.structureComplete).toBe(false);
  });
});
