import { describe, expect, it } from 'vitest';
import { datasetLabel } from './bi-labels';

describe('the name of a dataset on the screen of the BI logins (INT-2)', () => {
  const t = (key: string): string => `[${key}]`;

  it('names the three certified datasets by their own key and a code nobody knows by itself', () => {
    expect(datasetLabel(t, 'DS-DISB')).toBe('[int.bi.dataset.name.disbursement]');
    expect(datasetLabel(t, 'DS-CTR')).toBe('[int.bi.dataset.name.contracts]');
    expect(datasetLabel(t, 'DS-ENT')).toBe('[int.bi.dataset.name.enterprise]');
    expect(datasetLabel(t, 'DS-XYZ')).toBe('DS-XYZ');
  });
});
