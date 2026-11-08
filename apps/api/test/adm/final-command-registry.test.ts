import { BUSINESS_TYPES } from '@machvon/kernel';
import type { FinalCommand } from '@machvon/db';
import { FinalCommandRegistry } from '../../src/modules/adm/approval.service';

type Call = Parameters<FinalCommand>[0];

const callOf = (businessType: string): Call => ({ tx: {} as Call['tx'], instance: { businessType } as Call['instance'], outcome: 'APPROVED', command: 'cmd', idempotencyKey: 'wf:key' });

/** The registry of the final commands as it is in a test build: every business type answers, the double accepts, a real handler replaces it (the behaviour WF-1 keeps for the tests of the engine, R14). */
describe('the registry of the final commands in a test build', () => {
  it('binds every business type to a handler that applies, until the owning module registers its own', async () => {
    const registry = new FinalCommandRegistry();
    for (const type of BUSINESS_TYPES) expect(await registry.handlerOf(type.code)(callOf(type.code))).toBe('APPLIED');
  });

  it('replaces the double by the real handler of a business type and leaves the others alone', async () => {
    const registry = new FinalCommandRegistry();
    registry.register('report.accept', () => Promise.resolve('GUARD_REJECTED'));
    expect(await registry.asFinalCommand()(callOf('report.accept'))).toBe('GUARD_REJECTED');
    expect(await registry.asFinalCommand()(callOf('plan.publish'))).toBe('APPLIED');
  });

  it('refuses to register a business type nobody knows, and has no handler for one', () => {
    const registry = new FinalCommandRegistry();
    expect(() => registry.register('nothing.here', () => Promise.resolve('APPLIED'))).toThrow('is not a registered business type');
    expect(() => registry.handlerOf('nothing.here')).toThrow('no final command is registered');
  });
});
