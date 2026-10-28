import { randomBytes } from 'node:crypto';
import { biModule } from '../../src/modules/bi';
import { BI_DRILL_KEY, BI_DRILL_SECRET } from '../../src/modules/bi/tokens';
import { AppModule } from '../../src/app.module';

type Factory = (secret?: Buffer, options?: { contextKey: Buffer }) => Buffer;

describe('the signing key of the drill tokens', () => {
  const factory = (): Factory => {
    const provider = (biModule.providers ?? []).find((candidate) => (candidate as { provide?: unknown }).provide === BI_DRILL_KEY) as { useFactory: Factory };
    return provider.useFactory;
  };

  it('is the same in every replica and after a restart when the host configures a secret, and differs between secrets', () => {
    const secret = randomBytes(32);
    const make = factory();
    expect(make(secret).equals(make(Buffer.from(secret)))).toBe(true);
    expect(make(secret).equals(make(randomBytes(32)))).toBe(false);
    // The configured secret itself is never the key: the outbox key signs other things.
    expect(make(secret).equals(secret)).toBe(false);
    expect(make(undefined, { contextKey: secret }).equals(make(secret))).toBe(true);
  });

  it('is made for the life of the process only when nothing is configured', () => {
    const make = factory();
    expect(make().length).toBe(32);
    expect(make().equals(make())).toBe(false);
  });

  it('is received from the host through the options of the application', () => {
    const secret = randomBytes(32);
    const providers = (AppModule.register({ biDrillSecret: secret } as never).providers ?? []) as { provide?: unknown; useValue?: unknown }[];
    expect(providers.find((provider) => provider.provide === BI_DRILL_SECRET)?.useValue).toBe(secret);
    const without = (AppModule.register({} as never).providers ?? []) as { provide?: unknown }[];
    expect(without.some((provider) => provider.provide === BI_DRILL_SECRET)).toBe(false);
  });
});
