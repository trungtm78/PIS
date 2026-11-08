import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { AlertRow } from './AlertRow';
import { rawItem } from './test-support';
import { toAlertItem } from './types';

const parse = (overrides: Record<string, unknown> = {}) => {
  const parsed = toAlertItem(rawItem('o1', overrides));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};
const row = (overrides: Record<string, unknown> = {}) =>
  render(
    <MemoryRouter>
      <ul>
        <AlertRow item={parse(overrides)} today="2026-11-07" />
      </ul>
    </MemoryRouter>,
  );

describe('toAlertItem: who an item is held for and where it was raised from', () => {
  it('reads the person an item stands in for and the level it was raised from', () => {
    expect(parse({ on_behalf_of: { id: 'u9', name: 'Lê Thị Vắng' }, promoted_from: 'WATCH' })).toMatchObject({ on_behalf_of: { id: 'u9', name: 'Lê Thị Vắng' }, promoted_from: 'WATCH' });
  });

  it('uses the id as the name when the name is missing, and ignores what is not a person or not a level', () => {
    expect(parse({ on_behalf_of: { id: 'u9' } }).on_behalf_of).toEqual({ id: 'u9', name: 'u9' });
    expect(parse({ on_behalf_of: { name: 'Nobody' }, promoted_from: 'MYSTERY' })).toMatchObject({ on_behalf_of: null, promoted_from: null });
    expect(parse({ on_behalf_of: 'u9' }).on_behalf_of).toBeNull();
  });

  it('keeps an item without the fields as before', () => {
    expect(parse()).toMatchObject({ on_behalf_of: null, promoted_from: null });
  });
});

describe('AlertRow: held for somebody and raised from a lower level', () => {
  it('says whose alert the person holds, in words', () => {
    row({ on_behalf_of: { id: 'u9', name: 'Lê Thị Vắng' } });
    expect(screen.getByTestId('on-behalf').textContent).toBe(t('alerts.item.onBehalf', { name: 'Lê Thị Vắng' }));
  });

  it('says the level it was raised from, in words', () => {
    row({ severity: 'ACTION', promoted_from: 'WATCH' });
    expect(screen.getByTestId('promoted').textContent).toBe(t('alerts.item.promoted', { from: t('alerts.severity.watch') }));
  });

  it('shows neither line for an ordinary item', () => {
    row();
    expect(screen.queryByTestId('on-behalf')).toBeNull();
    expect(screen.queryByTestId('promoted')).toBeNull();
  });
});
