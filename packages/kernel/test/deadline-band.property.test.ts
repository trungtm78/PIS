import fc from 'fast-check';
import { DomainError } from '../src/errors.ts';
import { BAND_RANK, bandOf, resolveBand } from '../src/deadline-band.ts';
import type { BandThresholds, PersonalThresholds } from '../src/deadline-band.ts';

/** Any valid ladder: red >= -1, yellow above red, green (when there is one) above yellow. */
const ladder: fc.Arbitrary<BandThresholds> = fc
  .tuple(fc.integer({ min: -1, max: 10 }), fc.integer({ min: 1, max: 20 }), fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }))
  .map(([red, step, extra]) => {
    const yellow = red + step;
    return { red_days: red, yellow_days: yellow, green_days: extra === null ? null : yellow + extra };
  });

const rank = (thresholds: BandThresholds, remaining: number): number => BAND_RANK[bandOf(remaining, thresholds) as keyof typeof BAND_RANK];
const DUE = { dueOn: '2026-11-20', today: '2026-11-09', unit: 'CALENDAR' } as const;

describe('deadline band properties', () => {
  it('is monotonic: fewer days remaining never give a milder band', () => {
    fc.assert(
      fc.property(ladder, fc.integer({ min: -500, max: 500 }), fc.integer({ min: 0, max: 50 }), (thresholds, remaining, more) => {
        expect(rank(thresholds, remaining)).toBeGreaterThanOrEqual(rank(thresholds, remaining + more));
      }),
    );
  });

  it('is red for every overdue deadline while the red line is at -1 or later', () => {
    fc.assert(
      fc.property(ladder, fc.integer({ min: -500, max: -1 }), (thresholds, remaining) => {
        expect(bandOf(remaining, thresholds)).toBe('RED');
      }),
    );
  });

  it('is never red above the red line and always red on or below it', () => {
    fc.assert(
      fc.property(ladder, fc.integer({ min: -500, max: 500 }), (thresholds, remaining) => {
        expect(bandOf(remaining, thresholds) === 'RED').toBe(remaining <= thresholds.red_days);
      }),
    );
  });

  it('never makes the band of a person later than the official one, and never moves the official one', () => {
    const personal: fc.Arbitrary<PersonalThresholds> = fc.record(
      { green_days: fc.option(fc.integer({ min: 1, max: 40 }), { nil: null }), yellow_days: fc.integer({ min: 0, max: 40 }), red_days: fc.integer({ min: -1, max: 40 }) },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(ladder, personal, fc.integer({ min: -20, max: 40 }), (system, mine, remaining) => {
        const dueOn = new Date(Date.parse('2026-11-09T00:00:00Z') + remaining * 86_400_000).toISOString().slice(0, 10);
        let result;
        try {
          result = resolveBand({ system, personal: mine }, {}, { ...DUE, dueOn });
        } catch (error) {
          if (error instanceof DomainError) return; // an order that does not hold once merged is refused, which is the rule
          throw error;
        }
        const alone = resolveBand({ system }, {}, { ...DUE, dueOn });
        expect(result.official).toEqual(alone.official);
        expect(BAND_RANK[(result.personal as { band: keyof typeof BAND_RANK }).band]).toBeGreaterThanOrEqual(BAND_RANK[result.official.band as keyof typeof BAND_RANK]);
      }),
    );
  });
});
