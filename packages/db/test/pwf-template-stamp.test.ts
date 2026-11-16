import { builtInCodes, builtInDefault, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import { GovernanceRuleStore } from '../src/governance-rule-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';

jest.setTimeout(600_000);

/**
 * R75 (docs PWF 22.2, 22.8) over the real save path of a rule draft: the stamp of a verified legal ground of a workflow template is the server's. The store passes the params of a `PROJECT_WORKFLOW_TEMPLATE` draft through the
 * preparation the type registered (kernel `prepareTemplateDraft`, which is `stampLegalVerification` against what the draft follows) and stores what comes out; no other type is touched.
 */

const harness = new AuthzHarness();
const store = new GovernanceRuleStore();

const AUTHOR = 1;
const SECOND = 2;
const CHECKER = 3;
const UNIT = 1;
const TYPE = pwfWorkflow.PROJECT_WORKFLOW_RULE_TYPE;
const TODAY = vietnamDateOf(new Date());
const STAMP_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Params = Record<string, unknown>;
type Ground = Record<string, unknown>;

const ground = (extra: Ground = {}): Ground => ({ document: 'ND_15_2021', article: 'Điều 5', verification: 'VERIFIED', ...extra });
const task = (code: string, grounds: Ground[]): Params => ({
  code,
  name: `Task ${code}`,
  phase: 'PREP',
  kind: 'TASK',
  duration_working_days: 3,
  required: true,
  responsible_role: 'WORKER_ROLE',
  priority: 'NORMAL',
  predecessors: [],
  legal_doc_types: [],
  form_templates: [],
  checklist: [],
  kpi_codes: [],
  when: [],
  ...(grounds.length === 0 ? {} : { legal_basis: grounds }),
});
const template = (tasks: Params[]): Params => ({ name: 'Stamp flow', phases: [{ code: 'PREP', name: 'Phase one', gates: [] }], tasks });

const as = <T>(member: number, run: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), run);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

type Saved = Awaited<ReturnType<GovernanceRuleStore['create']>>;
const save = (member: number, code: string, params: unknown, type: string = TYPE): Promise<Saved> =>
  as(member, (tx) => store.create(tx, { type, code, unitId: null, params, effectiveFrom: TODAY, effectiveTo: null, reason: 'A draft for the tests' }, memberId(member)));
const groundsOf = (params: Params, code: string): Ground[] => (((params.tasks as Params[]).find((one) => one.code === code)?.legal_basis ?? []) as Ground[]);
const hashOf = (params: unknown): string => pwfWorkflow.templateHash(pwfWorkflow.parseProjectWorkflowTemplate(params));
/** What the table holds for a version, read past the store. */
const storedParams = async (id: string): Promise<Params> => ((await owner<{ params: Params }>('select params from machvon.governance_rule where id = $1::uuid', [id]))[0] as { params: Params }).params;

/** Submits and approves a draft: the maker, a second person, a third. */
async function approve(id: string): Promise<void> {
  const submitted = await as(SECOND, async (tx) => store.submit(tx, id, ((await store.find(tx, id)) as { rowVersion: number }).rowVersion, memberId(SECOND)));
  await as(CHECKER, (tx) => store.approve(tx, id, submitted.rowVersion, memberId(CHECKER)));
}

beforeAll(async () => {
  await harness.start();
  await harness.seedUnits(TENANT_A, [{ n: UNIT, path: '/u1/' }]);
  for (const n of [AUTHOR, SECOND, CHECKER]) await harness.seedMembership(TENANT_A, n, UNIT);
});

afterAll(async () => {
  await harness.stop();
});

describe('the stamp of a verified legal ground is the server`s (R75)', () => {
  it('stamps a ground the person marks as verified with the caller and the time of the server, and never believes a stamp that is sent', async () => {
    const before = Date.now();
    const saved = await save(AUTHOR, 'STAMP_FRESH', template([task('TASK_A', [ground(), ground({ article: 'Điều 6', verified_by: memberId(CHECKER), verified_at: '2020-01-01T00:00:00.000Z' }), ground({ article: 'Điều 7', verification: 'UNVERIFIED' })])]));
    const [fresh, forged, open] = groundsOf(saved.params, 'TASK_A');
    expect(fresh).toEqual(ground({ verified_by: memberId(AUTHOR), verified_at: expect.stringMatching(STAMP_TIME) }));
    const at = Date.parse(fresh?.verified_at as string);
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(forged).toEqual(ground({ article: 'Điều 6', verification: 'UNVERIFIED' }));
    expect(open).toEqual(ground({ article: 'Điều 7', verification: 'UNVERIFIED' }));
    expect(saved.report).toEqual({ legal_verification: { stamped: 1, reset: 1 } });
    // What is stored is what was stamped, and the hash of the template is the hash of that.
    expect(await storedParams(saved.id)).toEqual(saved.params);
    expect(hashOf(await storedParams(saved.id))).toBe(hashOf(saved.params));
  });

  it('carries the stamp into a new version written by another person; an edited article, a line copied to another task and a clone under another code go back to unverified', async () => {
    const first = await save(AUTHOR, 'STAMP_CARRY', template([task('TASK_A', [ground()]), task('TASK_B', [])]));
    await approve(first.id);
    const stamp = groundsOf(first.params, 'TASK_A')[0] as Ground;
    expect(stamp.verified_by).toBe(memberId(AUTHOR));

    // The next version, by another person: the same ground at the same place keeps the stamp of the first, sent back with it or without it.
    const withStamp = await save(SECOND, 'STAMP_CARRY', template([task('TASK_A', [stamp]), task('TASK_B', [])]));
    expect(groundsOf(withStamp.params, 'TASK_A')).toEqual([stamp]);
    expect(withStamp.report).toEqual({ legal_verification: { stamped: 0, reset: 0 } });
    expect(hashOf(withStamp.params)).toBe(hashOf(first.params));
    const withoutStamp = await save(SECOND, 'STAMP_CARRY', template([task('TASK_A', [ground()]), task('TASK_B', [])]));
    expect(groundsOf(withoutStamp.params, 'TASK_A')).toEqual([stamp]);

    // The article is edited under the old stamp: the stamp was given to another text.
    const edited = await save(SECOND, 'STAMP_CARRY', template([task('TASK_A', [{ ...stamp, article: 'Điều 5a' }]), task('TASK_B', [])]));
    expect(groundsOf(edited.params, 'TASK_A')).toEqual([{ document: 'ND_15_2021', article: 'Điều 5a', verification: 'UNVERIFIED' }]);
    expect(edited.report).toEqual({ legal_verification: { stamped: 0, reset: 1 } });

    // The line is copied to another task with its stamp: it was verified for task A.
    const copied = await save(SECOND, 'STAMP_CARRY', template([task('TASK_A', [stamp]), task('TASK_B', [stamp])]));
    expect(groundsOf(copied.params, 'TASK_A')).toEqual([stamp]);
    expect(groundsOf(copied.params, 'TASK_B')).toEqual([ground({ verification: 'UNVERIFIED' })]);

    // The whole template is saved under another code: nothing of that code was ever verified.
    const cloned = await save(SECOND, 'STAMP_CLONE', first.params);
    expect(groundsOf(cloned.params, 'TASK_A')).toEqual([ground({ verification: 'UNVERIFIED' })]);
    expect(cloned.report).toEqual({ legal_verification: { stamped: 0, reset: 1 } });
    // Unless the person who clones says "I checked it" in that very save: then the stamp is theirs.
    const reverified = await save(SECOND, 'STAMP_CLONE_2', template([task('TASK_A', [ground()]), task('TASK_B', [])]));
    expect(groundsOf(reverified.params, 'TASK_A')[0]).toMatchObject({ verification: 'VERIFIED', verified_by: memberId(SECOND) });
  });

  it('keeps on a second save of a work in progress the stamp its first save gave', async () => {
    const approved = await save(AUTHOR, 'STAMP_TWICE', template([task('TASK_A', [ground({ verification: 'UNVERIFIED' })])]));
    await approve(approved.id);
    const firstSave = await save(SECOND, 'STAMP_TWICE', template([task('TASK_A', [ground()])]));
    const stamp = groundsOf(firstSave.params, 'TASK_A')[0] as Ground;
    expect(stamp).toMatchObject({ verified_by: memberId(SECOND), verified_at: expect.stringMatching(STAMP_TIME) });
    // The screen sends back what it loaded, the stamp included, with another change next to it.
    const secondSave = await save(SECOND, 'STAMP_TWICE', template([task('TASK_A', [stamp, ground({ article: 'Điều 8', verification: 'UNVERIFIED' })])]));
    expect(groundsOf(secondSave.params, 'TASK_A')[0]).toEqual(stamp);
    expect(secondSave.report).toEqual({ legal_verification: { stamped: 0, reset: 0 } });
    // And a third person who saves on top of that keeps it too: the stamp says who verified, not who saved last.
    const thirdSave = await save(AUTHOR, 'STAMP_TWICE', secondSave.params);
    expect(thirdSave.params).toEqual(secondSave.params);
  });

  it('leaves a template verified before stamps existed exactly as it is: the same params, the same hash', async () => {
    const legacy = template([task('TASK_A', [ground(), ground({ article: 'Điều 9', verification: 'UNVERIFIED' })])]);
    await owner(
      `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, $2, 'STAMP_LEGACY', 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'A template written before stamps', $4, $5, now(), $6, now())`,
      [TENANT_A, TYPE, JSON.stringify(legacy), memberId(AUTHOR), memberId(SECOND), memberId(CHECKER)],
    );
    const saved = await save(SECOND, 'STAMP_LEGACY', legacy);
    expect(saved.params).toEqual(legacy);
    expect(JSON.stringify(await storedParams(saved.id))).toBe(JSON.stringify(((await owner<{ params: Params }>(`select params from machvon.governance_rule where code = 'STAMP_LEGACY' and version = 1`))[0] as { params: Params }).params));
    expect(hashOf(saved.params)).toBe(hashOf(legacy));
    expect(saved.report).toEqual({ legal_verification: { stamped: 0, reset: 0 } });
  });

  it.each(builtInCodes(TYPE))('keeps the params and the hash of the built-in template %s when it is saved as a draft of the tenant', async (code) => {
    const builtin = builtInDefault(TYPE, code)?.params as Params;
    const saved = await save(AUTHOR, code, builtin);
    expect(saved.params).toEqual(builtin);
    expect(await storedParams(saved.id)).toEqual(builtin);
    expect(hashOf(await storedParams(saved.id))).toBe(hashOf(builtin));
    expect(saved.report).toEqual({ legal_verification: { stamped: 0, reset: 0 } });
  });

  it('touches no other rule type: its draft is stored as it was judged and nothing is told', async () => {
    const policy = builtInDefault('DEADLINE_BAND_POLICY', 'PROJECT_TASK')?.params as Params;
    const saved = await save(AUTHOR, 'PROJECT_TASK', policy, 'DEADLINE_BAND_POLICY');
    expect(saved.params).toEqual(policy);
    expect(saved.report).toBeUndefined();
  });
});
