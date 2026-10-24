import { MockIdentityPort, UnboundIdentityPort } from '../../src/modules/bid/identity-port';
import { bidModule } from '../../src/modules/bid';
import { CONTRACTOR_IDENTITY_PORT } from '../../src/modules/bid/tokens';

describe('the lookup of a tax id (ST-BID-002)', () => {
  it('binds the unbound adapter by default: it says MISSING and asks nobody', async () => {
    const bound = (bidModule.providers ?? []).find((provider) => (provider as { provide?: unknown }).provide === CONTRACTOR_IDENTITY_PORT) as { useValue: UnboundIdentityPort };
    expect(bound.useValue).toBeInstanceOf(UnboundIdentityPort);
    expect(bound.useValue).toMatchObject({ provider: 'NONE', adapterStatus: 'MISSING' });
    const answer = await bound.useValue.lookup();
    expect(answer.outcome).toBe('UNAVAILABLE');
    expect(answer.checkedAt).toBeInstanceOf(Date);
  });

  it('answers from what the mock was given: MATCH ignoring case and spaces, NAME_MISMATCH for another name, NOT_FOUND for an unknown tax id', async () => {
    const port = new MockIdentityPort().register('0101234567', 'Cty Nha Thau Mot');
    expect(port).toMatchObject({ provider: 'MOCK', adapterStatus: 'MOCK' });
    expect((await port.lookup('0101234567', '  cty nha thau MOT ')).outcome).toBe('MATCH');
    expect((await port.lookup('0101234567', 'Cty Khac')).outcome).toBe('NAME_MISMATCH');
    expect((await port.lookup('0109999999', 'Cty Nha Thau Mot')).outcome).toBe('NOT_FOUND');
  });

  it('fails like a register that is down while it is not reachable, and can stand in for an adapter of any status', async () => {
    const port = new MockIdentityPort('PROPOSED').setReachable(false);
    expect(port.adapterStatus).toBe('PROPOSED');
    await expect(port.lookup('0101234567', 'X')).rejects.toThrow('cannot be reached');
    await expect(port.setReachable(true).lookup('0101234567', 'X')).resolves.toMatchObject({ outcome: 'NOT_FOUND' });
  });
});
