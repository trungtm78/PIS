import { describe, expect, it } from 'vitest';
import { ganttZones } from './GanttChart';

const row = (zones: { green: string | null; yellow: string; red: string } | null) => ({ actual: { from: '2026-12-01', to: '2026-12-10' }, zones });

describe('the zones of the three colours inside a bar', () => {
  it('draws grey, green, yellow and red from the first day each colour begins up to the finish', () => {
    expect(ganttZones(row({ green: '2026-12-04', yellow: '2026-12-07', red: '2026-12-09' }))).toEqual([
      { zone: 'idle', from: '2026-12-01', to: '2026-12-03' },
      { zone: 'green', from: '2026-12-04', to: '2026-12-06' },
      { zone: 'yellow', from: '2026-12-07', to: '2026-12-08' },
      { zone: 'red', from: '2026-12-09', to: '2026-12-10' },
    ]);
  });

  it('takes every day above the yellow line as green for a ladder without a green line (no grey zone)', () => {
    expect(ganttZones(row({ green: null, yellow: '2026-12-05', red: '2026-12-08' })).map((part) => part.zone)).toEqual(['green', 'yellow', 'red']);
  });

  it('cuts a zone that begins before the row at the start of the row, and draws nothing for a row without zones or without dates', () => {
    expect(ganttZones(row({ green: '2026-11-01', yellow: '2026-11-20', red: '2026-12-09' })).map((part) => [part.zone, part.from, part.to])).toEqual([
      ['yellow', '2026-12-01', '2026-12-08'],
      ['red', '2026-12-09', '2026-12-10'],
    ]);
    expect(ganttZones(row(null))).toEqual([]);
    expect(ganttZones({ actual: null, zones: { green: null, yellow: '2026-12-05', red: '2026-12-08' } })).toEqual([]);
  });
});
