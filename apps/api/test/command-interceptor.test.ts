import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuditWriter, IdempotencyStore, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { from, of } from 'rxjs';
import { CommandInterceptor } from '../src/command.interceptor';
import { OperationId } from '../src/operation-id.decorator';

class Routes {
  @OperationId('createCustomRole')
  createRole(): void {}
}

const TENANT = '00000000-0000-4000-8000-00000000000a';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000f1';

function harness(claimed: boolean, options: { handler?: unknown; body?: unknown } = {}) {
  const finish = jest.fn().mockResolvedValue(undefined);
  const store = {
    begin: jest.fn().mockResolvedValue({ kind: 'started', recordId: 'record-1' }),
    claimInTx: jest.fn().mockResolvedValue(claimed),
    completeInTx: jest.fn().mockResolvedValue(undefined),
    finishOutsideTx: finish,
  } as unknown as IdempotencyStore;
  const database = { withTenant: (_ctx: unknown, work: (tx: TenantTx) => Promise<unknown>) => work({ query: jest.fn() }) } as unknown as TenantDatabase;
  const reflector = { get: () => ({ operation: 'createWidget' }) } as unknown as Reflector;
  const handle = jest.fn(() => of({ ok: true }));
  const next: CallHandler = { handle };
  const request = {
    method: 'POST',
    headers: { 'idempotency-key': 'key-0123456789abcdef' },
    params: {},
    body: 'body' in options ? options.body : { name: 'w' },
    tenantContext: { tenantId: TENANT, membershipId: MEMBERSHIP, scopeVersion: 1 },
  };
  const context = {
    getHandler: () => options.handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: jest.fn() }) }),
  } as unknown as ExecutionContext;
  const interceptor = new CommandInterceptor(reflector, database, store, {} as AuditWriter);
  return { interceptor, context, next, handle, finish, store };
}

describe('CommandInterceptor ownership of the idempotency record', () => {
  it('runs the handler and lets the owner settle the record as retryable when the command fails', async () => {
    const { interceptor, context, next, handle, finish } = harness(true);
    await expect(new Promise((resolve, reject) => interceptor.intercept(context, next).subscribe({ next: resolve, error: reject }))).rejects.toThrow('wrote no audit entry');
    expect(handle).toHaveBeenCalledTimes(1);
    // The failure is a plain error (no audit entry), so the record is settled as retryable by its owner.
    expect(finish).toHaveBeenCalledWith(expect.anything(), 'record-1', { retryable: true });
  });

  it('answers 409 IDEMPOTENCY_IN_PROGRESS without running the handler or settling the record when the claim is lost (AC-ST-ADM-001-1)', async () => {
    const { interceptor, context, next, handle, finish } = harness(false);
    const failure = await new Promise<unknown>((resolve) => interceptor.intercept(context, next).subscribe({ next: resolve, error: resolve }));
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });
    expect(handle).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('validates the body against the schema of its operation before anything is stored', async () => {
    const handler = Routes.prototype.createRole;
    for (const [body, code] of [
      [{ name: 'Clerk', permissions: ['iam.unit.manage'], rank: 35, code: 'UNIT_CLERK', is_system: true }, 'FIELD_NOT_ALLOWED'],
      [{ name: 'Clerk' }, 'INVALID_REQUEST'],
      [{ name: 'Clerk', permissions: ['iam.unit.manage'], rank: 95, code: 'UNIT_CLERK' }, 'INVALID_REQUEST'],
    ] as const) {
      const { interceptor, context, next, handle, store, finish } = harness(true, { handler, body });
      const failure = await new Promise<unknown>((resolve) => interceptor.intercept(context, next).subscribe({ next: resolve, error: resolve }));
      expect(failure).toMatchObject({ code, status: 400 });
      expect(store.begin).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
    }
  });

  it('lets a valid body of a real operation through to the handler', async () => {
    const handler = Routes.prototype.createRole;
    const body = { code: 'UNIT_CLERK', name: 'Clerk', permissions: ['iam.unit.manage'], rank: 35 };
    const { interceptor, context, next, handle, store } = harness(true, { handler, body });
    await new Promise<unknown>((resolve) => interceptor.intercept(context, next).subscribe({ next: resolve, error: resolve }));
    expect(store.begin).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe('CommandInterceptor after-commit callbacks', () => {
  // A handler that writes its audit entry and registers callbacks the way a command does through the scope.
  function runWith(register: (afterCommit: (callback: () => void | Promise<void>) => void) => void, options: { failAfterRegistering?: boolean } = {}) {
    const calls: string[] = [];
    const { interceptor, context, next, handle, store } = harness(true);
    const request = (context.switchToHttp().getRequest() as unknown) as { commandScope?: { audit(entry: unknown): Promise<string>; afterCommit(callback: () => void | Promise<void>): void } };
    handle.mockImplementation((() => {
      const scope = request.commandScope;
      if (scope === undefined) throw new Error('no scope');
      return from(
        (async () => {
          await scope.audit({ action: 'a', resourceType: 'r', resourceId: '00000000-0000-4000-8000-000000000001', diff: {} });
          register(scope.afterCommit);
          if (options.failAfterRegistering === true) throw new DomainError('RESOURCE_NOT_FOUND', 404);
          return { ok: true };
        })(),
      );
    }) as never);
    (interceptor as unknown as { audit: { recordInTx: jest.Mock } }).audit = { recordInTx: jest.fn().mockResolvedValue('audit-1') };
    (store.completeInTx as jest.Mock).mockImplementation(() => {
      calls.push('completed');
      return Promise.resolve();
    });
    return { interceptor, context, next, calls };
  }

  const settle = (interceptor: CommandInterceptor, context: ExecutionContext, next: CallHandler): Promise<unknown> =>
    new Promise((resolve) => interceptor.intercept(context, next).subscribe({ next: resolve, error: resolve }));

  it('runs the callbacks in order after the transaction committed, before the answer', async () => {
    const { interceptor, context, next, calls } = runWith((afterCommit) => {
      afterCommit(() => {
        calls.push('first');
      });
      afterCommit(async () => {
        await Promise.resolve();
        calls.push('second');
      });
    });
    expect(await settle(interceptor, context, next)).toEqual({ ok: true });
    expect(calls).toEqual(['completed', 'first', 'second']);
  });

  it('does not run them when the command fails and the transaction rolls back', async () => {
    const { interceptor, context, next, calls } = runWith(
      (afterCommit) =>
        afterCommit(() => {
          calls.push('ran');
        }),
      { failAfterRegistering: true },
    );
    expect(await settle(interceptor, context, next)).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(calls).not.toContain('ran');
  });

  it('keeps the committed answer when a callback fails and still runs the others', async () => {
    const { interceptor, context, next, calls } = runWith((afterCommit) => {
      afterCommit(() => Promise.reject(new Error('cache down')));
      afterCommit(() => {
        calls.push('second');
      });
    });
    expect(await settle(interceptor, context, next)).toEqual({ ok: true });
    expect(calls).toContain('second');
  });
});

describe('CommandInterceptor refusal that commits what the command wrote (ST-PAY-007)', () => {
  type Scope = { audit(entry: unknown): Promise<string>; afterCommit(callback: () => void | Promise<void>): void; refuseAfterCommit(error: DomainError): void };

  function runRefusing(refuse: (scope: Scope) => void) {
    const { interceptor, context, next, handle, store, finish } = harness(true);
    const request = (context.switchToHttp().getRequest() as unknown) as { commandScope?: Scope };
    const calls: string[] = [];
    handle.mockImplementation((() => {
      const scope = request.commandScope;
      if (scope === undefined) throw new Error('no scope');
      return from(
        (async () => {
          await scope.audit({ action: 'a', resourceType: 'r', resourceId: '00000000-0000-4000-8000-000000000001', diff: {} });
          scope.afterCommit(() => {
            calls.push('after-commit');
          });
          refuse(scope);
          return { ok: true };
        })(),
      );
    }) as never);
    (interceptor as unknown as { audit: { recordInTx: jest.Mock } }).audit = { recordInTx: jest.fn().mockResolvedValue('audit-1') };
    (store.completeInTx as jest.Mock).mockImplementation(() => {
      calls.push('completed');
      return Promise.resolve();
    });
    return { interceptor, context, next, store, finish, calls };
  }

  const settle = (interceptor: CommandInterceptor, context: ExecutionContext, next: CallHandler): Promise<unknown> =>
    new Promise((resolve) => interceptor.intercept(context, next).subscribe({ next: resolve, error: resolve }));

  it('commits the command, stores the refusal as the answer of the key and answers it after the callbacks ran', async () => {
    const refusal = new DomainError('AMOUNT_MISMATCH_OPENED', 422, 'amount_vnd', { extensions: { reconciliation_item_id: 'item-1' } });
    const { interceptor, context, next, store, finish, calls } = runRefusing((scope) => scope.refuseAfterCommit(refusal));
    expect(await settle(interceptor, context, next)).toBe(refusal);
    expect(calls).toEqual(['completed', 'after-commit']);
    expect(store.completeInTx).toHaveBeenCalledWith(
      expect.anything(),
      'record-1',
      expect.objectContaining({ httpStatus: 422, response: { kind: 'problem', code: 'AMOUNT_MISMATCH_OPENED', status: 422, detail: 'amount_vnd', extensions: { reconciliation_item_id: 'item-1' } } }),
    );
    // The record is completed by the transaction itself: nothing settles it a second time.
    expect(finish).not.toHaveBeenCalled();
  });

  it('keeps the first refusal when the command asks twice', async () => {
    const first = new DomainError('AMOUNT_MISMATCH_OPENED', 422);
    const { interceptor, context, next } = runRefusing((scope) => {
      scope.refuseAfterCommit(first);
      scope.refuseAfterCommit(new DomainError('PAYMENT_STATE_INVALID', 409));
    });
    expect(await settle(interceptor, context, next)).toBe(first);
  });

  it('answers the result as before when the command does not refuse', async () => {
    const { interceptor, context, next, store } = runRefusing(() => undefined);
    expect(await settle(interceptor, context, next)).toEqual({ ok: true });
    expect(store.completeInTx).toHaveBeenCalledWith(expect.anything(), 'record-1', expect.objectContaining({ response: { kind: 'success', body: { ok: true } } }));
  });
});
