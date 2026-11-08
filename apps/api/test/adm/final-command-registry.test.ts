import { BUSINESS_TYPES, enabledBusinessTypes, testDoublesAllowed } from '@machvon/kernel';
import type { FinalCommand } from '@machvon/db';
import { ApprovalBootGuard, FinalCommandRegistry } from '../../src/modules/adm/approval.service';

type Call = Parameters<FinalCommand>[0];

const callOf = (businessType: string): Call => ({
  tx: {} as Call['tx'],
  instance: { businessType } as Call['instance'],
  outcome: 'APPROVED',
  command: 'cmd',
  idempotencyKey: 'wf:key',
  effects: { actor: 'actor', audit: () => Promise.resolve(), emit: () => Promise.resolve() },
});

const PRODUCTION = { NODE_ENV: 'production' };
const TEST = { NODE_ENV: 'test' };

/** The registry of the final commands in a test build: every business type answers, the double accepts, a real handler replaces it (the behaviour WF-1 keeps for the tests of the engine, R14). */
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
    expect(registry.hasRealHandler('report.accept')).toBe(true);
    expect(registry.hasRealHandler('plan.publish')).toBe(false);
  });

  it('refuses to register a business type nobody knows, and has no handler for one', () => {
    const registry = new FinalCommandRegistry();
    expect(() => registry.register('nothing.here', () => Promise.resolve('APPLIED'))).toThrow('is not a registered business type');
    expect(() => registry.handlerOf('nothing.here')).toThrow('no final command is registered');
  });
});

/** R14: the double exists in a test build only; a production process has none, cannot start an instance of a type without a real handler and does not boot when it enables one. */
describe('the registry of the final commands outside a test build (R14)', () => {
  it('knows a test build by NODE_ENV and nothing else', () => {
    expect(testDoublesAllowed(TEST)).toBe(true);
    for (const variables of [PRODUCTION, {}, { NODE_ENV: 'development' }, { NODE_ENV: 'test ', MACHVON_ENVIRONMENT: 'ci' }]) expect(testDoublesAllowed(variables)).toBe(false);
  });

  it('has no double: every business type is without a handler until the owner registers one', () => {
    const registry = new FinalCommandRegistry({ variables: PRODUCTION });
    for (const type of BUSINESS_TYPES) {
      expect(registry.canHandle(type.code)).toBe(false);
      expect(() => registry.handlerOf(type.code)).toThrow('no final command is registered');
    }
    registry.register('report.accept', () => Promise.resolve('APPLIED'));
    expect(registry.canHandle('report.accept')).toBe(true);
    expect(registry.canHandle('plan.publish')).toBe(false);
  });

  it('refuses to be asked for the doubles anywhere but in a test build', () => {
    expect(() => new FinalCommandRegistry({ testDoubles: true, variables: PRODUCTION })).toThrow('exist only in a test build');
    expect(() => new FinalCommandRegistry({ testDoubles: true, variables: TEST })).not.toThrow();
  });

  it('enables the business types of the platform by default and the ones the deployment names, for the modules that are mounted', () => {
    expect(enabledBusinessTypes({})).toEqual(['report.accept']);
    expect(enabledBusinessTypes({ MACHVON_APPROVAL_BUSINESS_TYPES: 'plan.publish, payment.approve' })).toEqual(['report.accept', 'plan.publish', 'payment.approve']);
    expect(enabledBusinessTypes({}, ['ADM', 'CAP'])).toEqual([]);
    expect(enabledBusinessTypes({ MACHVON_APPROVAL_BUSINESS_TYPES: 'plan.publish' }, ['ADM', 'CAP', 'DIS'])).toEqual(['report.accept', 'plan.publish']);
    expect(() => enabledBusinessTypes({ MACHVON_APPROVAL_BUSINESS_TYPES: 'nothing.here' })).toThrow('is not a business type');
  });

  it('stops the boot of a process that enables a business type with no real handler, naming it, and lets one with the handler start', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const registry = new FinalCommandRegistry({ variables: PRODUCTION });
      expect(() => new ApprovalBootGuard(registry, ['ADM', 'DIS']).onApplicationBootstrap()).toThrow('report.accept');
      registry.register('report.accept', () => Promise.resolve('APPLIED'));
      expect(() => new ApprovalBootGuard(registry, ['ADM', 'DIS']).onApplicationBootstrap()).not.toThrow();
      expect(() => new ApprovalBootGuard(registry, ['ADM']).onApplicationBootstrap()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('lets a test build boot on the doubles', () => {
    const registry = new FinalCommandRegistry();
    expect(registry.missingHandlers(['report.accept', 'plan.publish'], TEST)).toEqual([]);
    expect(new FinalCommandRegistry({ variables: PRODUCTION }).missingHandlers(['report.accept', 'plan.publish'], PRODUCTION)).toEqual(['report.accept', 'plan.publish']);
  });
});
