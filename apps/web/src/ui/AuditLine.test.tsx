import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuditLine } from './AuditLine';

describe('AuditLine', () => {
  it('lists each label with its value in a named list', () => {
    render(
      <AuditLine
        items={[
          { label: 'Tạo bởi', value: 'Nguyễn An · 01/11/2026' },
          { label: 'Sửa lần cuối', value: 'Trần Bình · 05/11/2026' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Dấu vết ghi nhận' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Tạo bởi Nguyễn An · 01/11/2026');
    expect(items[1]).toHaveTextContent('Sửa lần cuối Trần Bình · 05/11/2026');
  });
});
