import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusPill } from './StatusPill';
import type { Tone } from './types';

describe('StatusPill', () => {
  it.each<Tone>(['default', 'success', 'warning', 'danger', 'info', 'neutral'])('shows the text with the %s tone', (tone) => {
    render(<StatusPill tone={tone}>Đã duyệt</StatusPill>);
    expect(screen.getByText('Đã duyệt').parentElement).toHaveClass(`ui-tone-${tone}`);
  });

  it('keeps the text when an icon is given and hides the icon from assistive technology', () => {
    render(
      <StatusPill tone="danger" icon="!">
        Quá hạn
      </StatusPill>,
    );
    expect(screen.getByText('Quá hạn')).toBeInTheDocument();
    expect(screen.getByText('!')).toHaveAttribute('aria-hidden', 'true');
  });
});
