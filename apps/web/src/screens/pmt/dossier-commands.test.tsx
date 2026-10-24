import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useProjectOptions } from './dossier-commands';
import { OFFICER, client, mount, projectRow, world } from './dossier-test-support';

afterEach(cleanup);

function Probe({ enabled = true }: { enabled?: boolean }) {
  const projects = useProjectOptions(enabled);
  if (projects.isLoading) return <p>loading</p>;
  if (projects.isError) return <p>failed</p>;
  return <p data-testid="codes">{(projects.data ?? []).map((project) => project.code).join(',')}</p>;
}

describe('useProjectOptions (PMT-01): the projects a dossier can be opened for', () => {
  it('reads the register of the caller and leaves out the rows it cannot trust', async () => {
    mount(<Probe />, client(world({ projects: [projectRow(1), { id: 'broken' }, projectRow(2)] })), { permissions: OFFICER });
    expect((await screen.findByTestId('codes')).textContent).toBe('DA-2026-001,DA-2026-002');
  });

  it('does not read while it is not asked to', () => {
    const h = client(world({ projects: [projectRow(1)] }));
    mount(<Probe enabled={false} />, h, { permissions: OFFICER });
    expect(screen.getByTestId('codes').textContent).toBe('');
    expect((h.client as unknown as { readAll: { mock: { calls: unknown[] } } }).readAll.mock.calls).toEqual([]);
  });

  it('reports a read that failed', async () => {
    mount(<Probe />, client(world({ failing: new Set(['get_resources_project']) })), { permissions: OFFICER });
    expect(await screen.findByText('failed')).toBeTruthy();
  });
});
