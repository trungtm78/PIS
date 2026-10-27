import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { loadPlatformTemplates } from '../../src/modules/doc/template-pack';
import { MneFormsController } from '../../src/modules/mne/mne-forms.controller';
import { MneObligationRulesController } from '../../src/modules/mne/mne-obligation-rules.controller';
import { MneObligationsController } from '../../src/modules/mne/mne-obligations.controller';
import { MneReportsController } from '../../src/modules/mne/mne-reports.controller';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);

/** Members of tenant A: the steps of a form and of a rule are held by different people (and a few who hold none). */
export const ADMIN = 1; // drafts forms and rules, generates the calendar of the whole tenant
export const APPROVER = 2; // publishes forms and rules
export const READER = 3; // reads the catalogue and the calendar of the whole tenant
export const NOBODY = 4; // no grant
export const SCOPED = 5; // generates and reads the calendar of the units under unit 2 only
export const EVERYTHING = 6; // holds every MNE permission: proves that nobody publishes what they drafted
export const PREPARER = 7; // prepares the reports of the whole tenant
export const SCOPED_PREPARER = 8; // prepares the reports of the units under unit 2 only

export const ROOT = 1;
export const BRANCH = 2;
export const INVESTORS = [3, 4, 5] as const; // under the branch
export const OUTSIDE = 6; // an investor outside the branch

export interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export class MneApp {
  readonly harness = new AuthzHarness();
  app!: RunningApp;

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    const units = [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BRANCH, path: `/${unitId(BRANCH)}/`, parent: ROOT },
      ...INVESTORS.map((n) => ({ n, path: `/${unitId(BRANCH)}/${unitId(n)}/`, parent: BRANCH })),
      { n: OUTSIDE, path: `/${unitId(OUTSIDE)}/`, parent: ROOT },
    ];
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, units);
      await harness.owner(tenant, [['update machvon.organization_unit set is_investor = true where id = any($1::uuid[])', [[...INVESTORS, OUTSIDE].map(unitId)]]]);
    }
    for (const n of [ADMIN, APPROVER, READER, NOBODY, SCOPED, EVERYTHING, PREPARER, SCOPED_PREPARER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'MNE_ADMIN', ['mne.form.manage', 'mne.calendar.manage', 'mne.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'MNE_APPROVER', ['mne.form.approve', 'mne.calendar.approve', 'mne.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'MNE_READER', ['mne.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'MNE_SCOPED', ['mne.calendar.manage', 'mne.read'], 40);
    await harness.seedRole(TENANT_A, 5, 'MNE_ALL', ['mne.form.manage', 'mne.form.approve', 'mne.calendar.manage', 'mne.calendar.approve', 'mne.read'], 60);
    await harness.seedRole(TENANT_A, 6, 'MNE_PREPARER', ['mne.report.prepare', 'mne.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'MNE_ALL', ['mne.form.manage', 'mne.form.approve', 'mne.calendar.manage', 'mne.calendar.approve', 'mne.read'], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: SCOPED, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
      { n: 5, member: EVERYTHING, role: 5, kind: 'TENANT' },
      { n: 6, member: PREPARER, role: 6, kind: 'TENANT' },
      { n: 7, member: SCOPED_PREPARER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    // The DOC library of each tenant: the layout profile of Decree 30/2020 and the platform pack with the templates MNE-TT44-M02 to M10.
    for (const tenant of [TENANT_A, TENANT_B]) await tenants.withTenant(contextFor(tenant, memberId(ADMIN)), (tx) => loadPlatformTemplates(tx, memberId(ADMIN)));
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MneFormsController, MneObligationRulesController, MneObligationsController, MneReportsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
  }

  async call(
    method: 'GET' | 'POST',
    url: string,
    options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string },
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async count(sql: string, params: unknown[] = [], tenantId: string = TENANT_A): Promise<number> {
    return Number((await this.harness.owner<{ n: string }>(tenantId, [[sql, params]]))[0]?.n);
  }

  /** Removes the forms, rules and obligations of a tenant so that a test starts from the pack alone. */
  reset(tenantId: string = TENANT_A): Promise<unknown[]> {
    return this.harness.owner(tenantId, [['delete from machvon.mne_report'], ['delete from machvon.mne_obligation_rule'], ['delete from machvon.mne_report_form']]);
  }
}

export { ACTOR, TENANT_A, TENANT_B, memberId, unitId };
