import { TECHNICAL_CLASSES } from '@machvon/kernel';
import type { RetentionPolicyContent } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import { RetentionPolicyStore } from '../src/retention-policy-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new RetentionPolicyStore();
const MAKER = 1;
const CHECKER = 2;
const TODAY = '2026-10-24';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

const draft = (overrides: Partial<RetentionPolicyContent> = {}): RetentionPolicyContent => ({
  record_class: 'project_dossier',
  retention_years: 10,
  retention_basis: 'FROM_CLOSED',
  legal_basis_ref: 'TT 10/2022/TT-BNV [CXN-RET-03]',
  end_action: 'REVIEW_FOR_DESTRUCTION',
  effective_from: '2026-01-01',
  ...overrides,
});

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; errors?: Array<{ field: string; code: string }> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: { errors?: Array<{ field: string; code: string }> } };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions?.errors === undefined ? {} : { errors: e.extensions.errors }) };
  }
  throw new Error('expected a refusal');
}

describe('RetentionPolicyStore (retention policy versions, ST-ADM-017)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('drafting', () => {
    it('writes revision 1 as a draft, then revision 2 per class, replacing the open draft', async () => {
      const first = await as((tx) => store.createDraft(tx, draft(), memberId(MAKER)));
      expect(first.row).toMatchObject({ recordClass: 'project_dossier', revision: 1, status: 'Draft', version: 1, approvedBy: null, publishedAt: null, retentionYears: 10, createdBy: memberId(MAKER) });
      expect(first.replacedDraftId).toBeUndefined();
      const second = await as((tx) => store.createDraft(tx, draft({ retention_years: 12 }), memberId(CHECKER)));
      expect(second.row).toMatchObject({ revision: 2, status: 'Draft', retentionYears: 12 });
      expect(second.replacedDraftId).toBe(first.row.id);
      expect(await as((tx) => store.find(tx, first.row.id))).toMatchObject({ status: 'Superseded', version: 2 });
      const other = await as((tx) => store.createDraft(tx, draft({ record_class: 'payment_dossier' }), memberId(MAKER)));
      expect(other.row.revision).toBe(1);
    });

    it('trims the legal basis and keeps a permanent policy without years', async () => {
      const row = (await as((tx) => store.createDraft(tx, draft({ record_class: 'audit_event', retention_basis: 'PERMANENT', retention_years: undefined, legal_basis_ref: '  Law on Archives 33/2024/QH15  ', end_action: 'ARCHIVE_TRANSFER' }), memberId(MAKER)))).row;
      expect(row).toMatchObject({ retentionYears: null, retentionBasis: 'PERMANENT', legalBasisRef: 'Law on Archives 33/2024/QH15', endAction: 'ARCHIVE_TRANSFER' });
    });

    it('refuses AUTO_PURGE_TECHNICAL for a business class and PERMANENT with ten years, with every finding (AC-ST-ADM-017-1, UAT-AC142)', async () => {
      const purge = await refusal(as((tx) => store.createDraft(tx, draft({ end_action: 'AUTO_PURGE_TECHNICAL' }), memberId(MAKER))));
      expect(purge).toMatchObject({ code: 'RETENTION_POLICY_INVALID', status: 422, detail: 'end_action', errors: [{ field: 'end_action', code: 'END_ACTION_NOT_ALLOWED' }] });
      const permanent = await refusal(as((tx) => store.createDraft(tx, draft({ retention_basis: 'PERMANENT', retention_years: 10 }), memberId(MAKER))));
      expect(permanent).toMatchObject({ code: 'RETENTION_POLICY_INVALID', status: 422, errors: [{ field: 'retention_years', code: 'YEARS_NOT_ALLOWED' }] });
      expect(await owner("select count(*)::int as n from machvon.data_retention_policy where record_class = 'project_dossier' and retention_basis = 'PERMANENT'")).toEqual([{ n: 0 }]);
    });

    it('does not write a revision or replace a draft when the new one is refused', async () => {
      const before = await owner<{ id: string; status: string }>("select id, status from machvon.data_retention_policy where record_class = 'payment_dossier' order by revision");
      await refusal(as((tx) => store.createDraft(tx, draft({ record_class: 'payment_dossier', end_action: 'AUTO_PURGE_TECHNICAL' }), memberId(MAKER))));
      expect(await owner("select id, status from machvon.data_retention_policy where record_class = 'payment_dossier' order by revision")).toEqual(before);
    });

    it('takes a technical class that is purged only, and refuses the other end actions for it', async () => {
      const technical = draft({ record_class: 'outbox_event', retention_basis: 'FROM_CREATED', retention_years: 1, end_action: 'AUTO_PURGE_TECHNICAL' });
      expect((await as((tx) => store.createDraft(tx, technical, memberId(MAKER)))).row.recordClass).toBe('outbox_event');
      expect(await refusal(as((tx) => store.createDraft(tx, { ...technical, end_action: 'REVIEW_FOR_DESTRUCTION' }, memberId(MAKER))))).toMatchObject({ code: 'RETENTION_POLICY_INVALID' });
    });
  });

  describe('the database holds the same rules as the code', () => {
    const insert = (overrides: Record<string, unknown>) => {
      const values = { record_class: 'project_dossier', revision: 90, years: 5, basis: 'FROM_CREATED', end_action: 'REVIEW_FOR_DESTRUCTION', status: 'Draft', approved_by: null, published_at: null, ...overrides };
      return owner(
        `insert into machvon.data_retention_policy
           (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, approved_by, published_at)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, 'Law on Archives', $6, date '2026-01-01', $7, $8, $9, $10)`,
        [TENANT_A, values.record_class, values.revision, values.years, values.basis, values.end_action, values.status, memberId(MAKER), values.approved_by, values.published_at],
      );
    };

    it('refuses what the code refuses, written past the code', async () => {
      await expect(insert({ end_action: 'AUTO_PURGE_TECHNICAL' })).rejects.toMatchObject({ constraint: 'data_retention_policy_purge_chk' });
      await expect(insert({ record_class: 'user_session', end_action: 'REVIEW_FOR_DESTRUCTION' })).rejects.toMatchObject({ constraint: 'data_retention_policy_purge_chk' });
      await expect(insert({ record_class: 'user_session', end_action: 'AUTO_PURGE_TECHNICAL', basis: 'FROM_CLOSED' })).rejects.toMatchObject({ constraint: 'data_retention_policy_technical_basis_chk' });
      await expect(insert({ basis: 'PERMANENT', years: 10 })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ years: null })).rejects.toMatchObject({ code: '23514' });
      await expect(insert({ years: 101 })).rejects.toMatchObject({ constraint: 'data_retention_policy_years_chk' });
      await expect(insert({ record_class: 'Bad Class' })).rejects.toMatchObject({ constraint: 'data_retention_policy_class_chk' });
      await expect(insert({ approved_by: memberId(CHECKER) })).rejects.toMatchObject({ constraint: 'data_retention_policy_draft_chk' });
      await expect(insert({ status: 'Published' })).rejects.toMatchObject({ constraint: 'data_retention_policy_published_chk' });
      await expect(insert({ status: 'Published', approved_by: memberId(MAKER), published_at: '2026-01-02' })).rejects.toMatchObject({ code: '23514' });
    });

    it('lists the technical classes of the code and no others in its check', async () => {
      const [constraint] = await owner<{ definition: string }>("select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'data_retention_policy_purge_chk'");
      const named = [...(constraint?.definition.matchAll(/'([a-z_]+)'::text/g) ?? [])].map((match) => match[1] as string).filter((name) => name !== 'AUTO_PURGE_TECHNICAL');
      expect([...new Set(named)].sort()).toEqual([...TECHNICAL_CLASSES].sort());
    });

    it('allows one version in force and one open draft per class', async () => {
      await insert({ record_class: 'report_revision', revision: 1, status: 'Draft' });
      await expect(insert({ record_class: 'report_revision', revision: 2, status: 'Draft' })).rejects.toMatchObject({ constraint: 'data_retention_policy_draft_uq' });
      await insert({ record_class: 'contract_dossier', revision: 1, status: 'Published', approved_by: memberId(CHECKER), published_at: '2026-01-02' });
      await expect(insert({ record_class: 'contract_dossier', revision: 2, status: 'Published', approved_by: memberId(CHECKER), published_at: '2026-01-03' })).rejects.toMatchObject({
        constraint: 'data_retention_policy_published_uq',
      });
    });

    it('keeps the content of a version for good, moves the status along its path only and never deletes', async () => {
      const [draftRow] = await owner<{ id: string }>("select id from machvon.data_retention_policy where record_class = 'report_revision' and status = 'Draft'");
      const id = draftRow?.id;
      for (const change of ["retention_years = 99", "record_class = 'payment_dossier'", "end_action = 'ARCHIVE_TRANSFER'", "legal_basis_ref = 'Other law'", "effective_from = date '2020-01-01'", "revision = 99"]) {
        await expect(owner(`update machvon.data_retention_policy set ${change} where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
      }
      await expect(owner("update machvon.data_retention_policy set approved_by = $2, version = version + 1 where id = $1", [id, memberId(CHECKER)])).rejects.toMatchObject({ code: '23514' });
      await owner("update machvon.data_retention_policy set status = 'Superseded' where id = $1", [id]);
      await expect(owner("update machvon.data_retention_policy set status = 'Published' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      const [published] = await owner<{ id: string }>("select id from machvon.data_retention_policy where record_class = 'contract_dossier' and status = 'Published'");
      await expect(owner("update machvon.data_retention_policy set status = 'Draft' where id = $1", [published?.id])).rejects.toMatchObject({ code: '23514' });
      await expect(as((tx) => tx.query('delete from machvon.data_retention_policy where id = $1', [published?.id]))).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('publishing', () => {
    const fresh = async (overrides: Partial<RetentionPolicyContent> = {}, member = MAKER) => (await as((tx) => store.createDraft(tx, draft({ record_class: 'payment_dossier', ...overrides }), memberId(member)), member)).row;

    it('is the work of someone other than the author and supersedes the version in force (BR-ADM-01)', async () => {
      const first = await fresh();
      expect(await refusal(as((tx) => store.lockDraft(tx, first.id, first.version).then((locked) => store.publish(tx, locked, memberId(MAKER), TODAY)), MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const published = await as(async (tx) => store.publish(tx, await store.lockDraft(tx, first.id, first.version), memberId(CHECKER), TODAY), CHECKER);
      expect(published).toEqual({ version: 2, supersededId: undefined });
      expect(await as((tx) => store.find(tx, first.id))).toMatchObject({ status: 'Published', approvedBy: memberId(CHECKER), version: 2, publishedAt: expect.stringMatching(/Z$/) });

      const second = await fresh({ retention_years: 15 });
      const next = await as(async (tx) => store.publish(tx, await store.lockDraft(tx, second.id, second.version), memberId(CHECKER), TODAY), CHECKER);
      expect(next.supersededId).toBe(first.id);
      expect(await as((tx) => store.find(tx, first.id))).toMatchObject({ status: 'Superseded' });
      expect([...(await as((tx) => store.published(tx))).keys()]).toContain('payment_dossier');
      expect((await as((tx) => store.published(tx))).get('payment_dossier')?.id).toBe(second.id);
    });

    it('answers 409 VERSION_CONFLICT to a stale version, to a version that is no draft any more and to a draft that a newer one replaced, and 404 to no version', async () => {
      const row = await fresh();
      expect(await refusal(as((tx) => store.lockDraft(tx, row.id, 99), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const replacement = await fresh({ retention_years: 20 });
      expect(await refusal(as((tx) => store.lockDraft(tx, row.id, 1), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await as(async (tx) => store.publish(tx, await store.lockDraft(tx, replacement.id, replacement.version), memberId(CHECKER), TODAY), CHECKER);
      expect(await refusal(as((tx) => store.lockDraft(tx, replacement.id, 2), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => store.lockDraft(tx, '00000000-0000-4000-8000-0000000000ff', 1), CHECKER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('waits for the day a version starts: it is refused before that day, with the finding, and published on it', async () => {
      const row = await fresh({ effective_from: '2026-11-01' });
      const early = await refusal(as(async (tx) => store.publish(tx, await store.lockDraft(tx, row.id, row.version), memberId(CHECKER), TODAY), CHECKER));
      expect(early).toMatchObject({ code: 'RETENTION_POLICY_INVALID', status: 422, detail: 'effective_from', errors: [{ field: 'effective_from', code: 'DATE_FUTURE' }] });
      expect(await as((tx) => store.find(tx, row.id))).toMatchObject({ status: 'Draft' });
      await as(async (tx) => store.publish(tx, await store.lockDraft(tx, row.id, row.version), memberId(CHECKER), '2026-11-01'), CHECKER);
      expect(await as((tx) => store.find(tx, row.id))).toMatchObject({ status: 'Published' });
    });
  });

  describe('reading', () => {
    it('pages by class and newest revision first without losing or repeating a version', async () => {
      const everything = await owner<{ record_class: string; revision: number; id: string }>('select record_class, revision, id from machvon.data_retention_policy order by record_class, revision desc');
      const seen: string[] = [];
      let after: { code: string; id: string } | undefined;
      for (let page = 0; page < 40; page += 1) {
        const rows = await as((tx) => store.list(tx, { limit: 3, after }));
        seen.push(...rows.map((row) => row.id));
        const last = rows[rows.length - 1];
        if (rows.length < 3 || last === undefined) break;
        after = store.cursorOf(last);
      }
      expect(seen).toEqual(everything.map((row) => row.id));
      expect(await refusal(as((tx) => store.list(tx, { limit: 3, after: { code: 'nonsense', id: 'x' } })))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
    });

    it('keeps one tenant from the versions of another', async () => {
      expect(await as((tx) => store.list(tx, { limit: 50, after: undefined }), MAKER, TENANT_B)).toEqual([]);
      expect((await as((tx) => store.published(tx), MAKER, TENANT_B)).size).toBe(0);
    });
  });

  describe('the platform baseline (master data RETENTION_POLICY)', () => {
    const baselineEntry = (key: string, extra: Record<string, unknown>) => ({
      masterType: 'RETENTION_POLICY',
      businessKey: key,
      label: key,
      attributes: { owner_module: 'DGV', awaiting_confirmation: true, cxn: 'CXN-05', data_class: key, classification: 'INTERNAL', legal_hold_allowed: false, ...extra },
      validFrom: '2025-01-01',
      legalBasis: 'baseline of the platform, awaiting CXN-05',
    });

    beforeAll(async () => {
      const retention = BASELINE_PACK.entries.filter((entry) => entry.masterType === 'RETENTION_POLICY');
      const pack = sealPack('RETENTION-ONLY', [...retention, baselineEntry('AUDIT_EVENT', { permanent: true })]);
      await as((tx) => applyBaseline(tx, pack, memberId(MAKER)), MAKER, TENANT_B);
    }, 120_000);

    const withClass = (recordClass: string, overrides: Partial<RetentionPolicyContent> = {}) =>
      as((tx) => store.createDraft(tx, draft({ record_class: recordClass, ...overrides }), memberId(MAKER)), MAKER, TENANT_B);

    it('reads the baseline of a class by its key in upper case, and knows none for a class the catalogue does not name', async () => {
      expect(await as((tx) => store.platformBaseline(tx, 'contract_record'), MAKER, TENANT_B)).toEqual({ years: 10, permanent: false });
      expect(await as((tx) => store.platformBaseline(tx, 'audit_event'), MAKER, TENANT_B)).toEqual({ years: undefined, permanent: true });
      expect(await as((tx) => store.platformBaseline(tx, 'project_dossier'), MAKER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => store.platformBaseline(tx, 'contract_record'))).toBeUndefined();
    });

    it('lets a tenant keep a class as long as the platform does or longer, and refuses less with the finding', async () => {
      const short = await refusal(withClass('contract_record', { retention_years: 5, retention_basis: 'FROM_CREATED' }));
      expect(short).toMatchObject({ code: 'RETENTION_POLICY_INVALID', status: 422, detail: 'retention_years', errors: [{ field: 'retention_years', code: 'BELOW_PLATFORM_BASELINE' }] });
      expect((await withClass('contract_record', { retention_years: 10, retention_basis: 'FROM_CREATED' })).row.retentionYears).toBe(10);
      expect((await withClass('contract_record', { retention_years: 25, retention_basis: 'FROM_CREATED' })).row.retentionYears).toBe(25);
      expect((await withClass('contract_record', { retention_basis: 'PERMANENT', retention_years: undefined })).row.retentionBasis).toBe('PERMANENT');
    });

    it('wants a class that the platform keeps for ever to be kept for ever', async () => {
      const finite = await refusal(withClass('audit_event', { retention_years: 90, retention_basis: 'FROM_CREATED', end_action: 'ARCHIVE_TRANSFER' }));
      expect(finite).toMatchObject({ code: 'RETENTION_POLICY_INVALID', errors: [{ code: 'BELOW_PLATFORM_BASELINE' }] });
      expect((await withClass('audit_event', { retention_basis: 'PERMANENT', retention_years: undefined, end_action: 'ARCHIVE_TRANSFER' })).row.retentionBasis).toBe('PERMANENT');
    });

    it('does not bind a tenant whose catalogue does not name the class', async () => {
      expect((await as((tx) => store.createDraft(tx, draft({ record_class: 'contract_record', retention_years: 1, retention_basis: 'FROM_CREATED' }), memberId(MAKER)))).row.retentionYears).toBe(1);
    });
  });
});
