import type { MetricsSink } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { ADM_METRICS } from '../src/modules/adm/tokens';

describe('the metrics sink of the API shell (ST-ADM-013)', () => {
  const sink: MetricsSink = { increment: () => undefined, gauge: () => undefined };
  const providersOf = (options: object): Array<{ provide?: unknown; useValue?: unknown }> => (AppModule.register(options as never).providers ?? []) as Array<{ provide?: unknown; useValue?: unknown }>;

  it('hands the sink of the policy options to the ADM controllers, so that the counters the alerts read (workflow_guard_rejected_total) are not lost', () => {
    const provided = providersOf({ database: {}, registry: {}, policy: { database: {}, access: {}, metrics: sink } }).find((provider) => provider.provide === ADM_METRICS);
    expect(provided?.useValue).toBe(sink);
  });

  it('provides none when the shell has no sink: the controllers then fall back to the silent one', () => {
    expect(providersOf({ database: {}, registry: {} }).some((provider) => provider.provide === ADM_METRICS)).toBe(false);
    expect(providersOf({ database: {}, registry: {}, policy: { database: {}, access: {} } }).some((provider) => provider.provide === ADM_METRICS)).toBe(false);
  });
});
