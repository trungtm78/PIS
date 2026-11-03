import { DomainError } from '@machvon/kernel';
import type { TableMeasure } from '@machvon/kernel';
import { measureSql } from '../src/placement-measure';
import type { MeasuredTenant } from '../src/placement-measure';
import { failureCodeOf } from '../src/placement-migration-runner';
import { MockPlacementMover, UnboundPlacementMover, defaultPlacementMover, sharedMockPlacementMover } from '../src/placement-mover';
import type { MoveRef } from '../src/placement-mover';

const MOVE: MoveRef = { migrationId: '00000000-0000-4000-8000-0000000000c1', tenantId: '00000000-0000-4000-8000-00000000000a', fromPlacementId: '00000000-0000-4000-8000-0000000000b1', toPlacementId: '00000000-0000-4000-8000-0000000000b2' };
const TABLES: TableMeasure[] = [{ table: 'allocation_line', rows: 3, checksum: '99', money: { amount_vnd: '500' } }];
const source = (tables: TableMeasure[] = TABLES) => ({ measure: async (): Promise<MeasuredTenant> => ({ tables, unreadable: [] }) });

describe('the stand-in for the data path of a promotion (ST-SAS-018, D02)', () => {
  it('holds a picture of what the original measures when it is copied, and answers it as the copy', async () => {
    const mover = new MockPlacementMover();
    expect(await mover.measureTarget(MOVE)).toEqual([]);
    expect(mover.holds(MOVE)).toBe(false);
    await mover.copy(MOVE, source());
    expect(mover.holds(MOVE)).toBe(true);
    expect(await mover.measureTarget(MOVE)).toEqual(TABLES);
    // What it answers is a copy: changing it changes nothing in the silo.
    const answered = await mover.measureTarget(MOVE);
    (answered[0] as TableMeasure).rows = 0;
    expect(await mover.measureTarget(MOVE)).toEqual(TABLES);
  });

  it('catches up with the original when it is synced, which heals a copy that was changed', async () => {
    const mover = new MockPlacementMover();
    await mover.copy(MOVE, source());
    mover.tamper(MOVE, (tables) => {
      (tables[0] as TableMeasure).money = { amount_vnd: '501' };
    });
    expect((await mover.measureTarget(MOVE))[0]?.money).toEqual({ amount_vnd: '501' });
    await mover.sync(MOVE, source());
    expect(await mover.measureTarget(MOVE)).toEqual(TABLES);
    await mover.sync(MOVE, source([{ table: 'allocation_line', rows: 4, checksum: '100', money: { amount_vnd: '600' } }]));
    expect((await mover.measureTarget(MOVE))[0]?.rows).toBe(4);
  });

  it('leaves the copy altered after the next copy or sync only, once, to stand for a copy with a row different', async () => {
    const mover = new MockPlacementMover();
    mover.tamperAfterNext((tables) => {
      (tables[0] as TableMeasure).rows = 99;
    });
    await mover.copy(MOVE, source());
    expect((await mover.measureTarget(MOVE))[0]?.rows).toBe(99);
    await mover.sync(MOVE, source());
    expect(await mover.measureTarget(MOVE)).toEqual(TABLES);
    mover.tamperAfterNext((tables) => {
      (tables[0] as TableMeasure).rows = 98;
    });
    await mover.sync(MOVE, source());
    expect((await mover.measureTarget(MOVE))[0]?.rows).toBe(98);
  });

  it('keeps the silo of each tenant and placement apart, and destroys a copy and forgets the old data on request', async () => {
    const mover = new MockPlacementMover();
    const other = { ...MOVE, toPlacementId: '00000000-0000-4000-8000-0000000000b3' };
    await mover.copy(MOVE, source());
    expect(mover.holds(other)).toBe(false);
    mover.tamper(other, () => {
      throw new Error('there is no silo to change');
    });
    await mover.discardTarget(MOVE);
    expect(mover.holds(MOVE)).toBe(false);
    expect(mover.purgedSource(MOVE.tenantId)).toBe(false);
    await mover.purgeSource(MOVE);
    expect(mover.purgedSource(MOVE.tenantId)).toBe(true);
    expect(mover.calls).toEqual([`copy:${MOVE.tenantId}`, `discardTarget:${MOVE.tenantId}`, `purgeSource:${MOVE.tenantId}`]);
  });

  it('fails the next call of the operation it was told to, once, and no other', async () => {
    const mover = new MockPlacementMover();
    for (const operation of ['copy', 'sync', 'measureTarget', 'discardTarget', 'purgeSource'] as const) {
      mover.failNext(operation, new DomainError('PLACEMENT_MOVER_UNAVAILABLE', 503));
      const attempt = () =>
        operation === 'copy' || operation === 'sync' ? mover[operation](MOVE, source()) : mover[operation](MOVE);
      await expect(attempt()).rejects.toMatchObject({ code: 'PLACEMENT_MOVER_UNAVAILABLE', status: 503 });
      await expect(attempt()).resolves.not.toThrow();
    }
    mover.failNext('purgeSource', new Error('boom'));
    await expect(mover.copy(MOVE, source())).resolves.toBeUndefined();
  });

  it('is refused in full by the mover of an environment that has none: nothing is claimed to have moved', async () => {
    const mover = new UnboundPlacementMover();
    for (const attempt of [() => mover.copy(), () => mover.sync(), () => mover.measureTarget(), () => mover.discardTarget(), () => mover.purgeSource()]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'PLACEMENT_MOVER_UNAVAILABLE', status: 503 });
    }
  });

  it('is the stand-in outside production and nothing in production (an unnamed environment is production)', () => {
    expect(defaultPlacementMover('test')).toBe(sharedMockPlacementMover());
    expect(defaultPlacementMover('staging')).toBe(sharedMockPlacementMover());
    expect(sharedMockPlacementMover()).toBe(sharedMockPlacementMover());
    for (const environment of ['production', undefined, '', 'prod']) expect(defaultPlacementMover(environment)).toBeInstanceOf(UnboundPlacementMover);
  });
});

describe('the SQL that measures a table (BR-SAS-05)', () => {
  it('hashes the whole row of the table the tenant sees, as jsonb text, and sums each money column', () => {
    expect(measureSql('allocation_line', ['amount_vnd', 'ctmtqg_subset_vnd'])).toBe(
      'select count(*)::text as n, coalesce(sum(hashtextextended(to_jsonb(r)::text, 0)::numeric), 0)::text as checksum, coalesce(sum(r."amount_vnd"), 0)::text as m0, coalesce(sum(r."ctmtqg_subset_vnd"), 0)::text as m1 from machvon."allocation_line" r',
    );
  });

  it('hashes the primary key instead of the content for a table of the own record of the promotion', () => {
    expect(measureSql('tenant_placement_migration', [], ['tenant_id', 'id'])).toBe(
      'select count(*)::text as n, coalesce(sum(hashtextextended(row(r."tenant_id", r."id")::text, 0)::numeric), 0)::text as checksum from machvon."tenant_placement_migration" r',
    );
  });

  it('has no money column to sum when there is none', () => {
    expect(measureSql('outbox_line', [])).toBe('select count(*)::text as n, coalesce(sum(hashtextextended(to_jsonb(r)::text, 0)::numeric), 0)::text as checksum from machvon."outbox_line" r');
  });

  it('quotes every name, so no table or column can bring SQL of its own', () => {
    expect(measureSql('a"b', ['m"1'])).toContain('machvon."a""b"');
    expect(measureSql('a"b', ['m"1'])).toContain('r."m""1"');
  });
});

describe('the class of a failure that the worker records', () => {
  it('is the code of a domain error, or of an error that carries one, else a generic one: never a message', () => {
    expect(failureCodeOf(new DomainError('PLACEMENT_MOVER_UNAVAILABLE', 503))).toBe('PLACEMENT_MOVER_UNAVAILABLE');
    expect(failureCodeOf(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(failureCodeOf(Object.assign(new Error('x'), { code: '42501' }))).toBe('STEP_FAILED');
    expect(failureCodeOf(new Error('password for tenant 7 is wrong'))).toBe('STEP_FAILED');
    expect(failureCodeOf('text')).toBe('STEP_FAILED');
    expect(failureCodeOf(undefined)).toBe('STEP_FAILED');
  });
});
