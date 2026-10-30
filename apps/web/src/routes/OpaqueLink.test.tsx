import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { OpaqueLink } from './OpaqueLink';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function open(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:id" element={<OpaqueLink />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the opaque link of a push (AC-ST-NOT-007-3, NOT02)', () => {
  it('opens the details of the notification it names, and nothing else travels', () => {
    open('/r/00000000-0000-4000-8000-000000000001');
    expect(screen.getByTestId('where').textContent).toBe('/not/not-02?id=00000000-0000-4000-8000-000000000001');
  });

  it('says not found for an id that is not the shape of a notification', () => {
    open('/r/short');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});
