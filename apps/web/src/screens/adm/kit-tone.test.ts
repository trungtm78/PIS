import { describe, expect, it } from 'vitest';
import { toneOfPill } from './kit-tone';

describe('toneOfPill', () => {
  it('maps the colour classes of the prototype pill to the tones of the kit, the plain pill being the good state', () => {
    expect(toneOfPill('pill')).toBe('success');
    expect(toneOfPill('pill green')).toBe('success');
    expect(toneOfPill('pill warn')).toBe('warning');
    expect(toneOfPill('pill red')).toBe('danger');
    expect(toneOfPill('pill gray')).toBe('neutral');
    expect(toneOfPill('pill blue')).toBe('info');
    expect(toneOfPill('pill ')).toBe('success');
  });
});
