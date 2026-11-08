import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import { LinkGraph } from './LinkGraph';
import { leadContractor, leadLink } from './test/investigation-fixtures';
import { text, word } from './test/helpers';
import { uuid } from '../shared/test/vnd-test-support';
import type { LinkNode } from './investigation-model';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const A = uuid('0001', 1);
const B = uuid('0001', 2);
const C = uuid('0001', 3);
const nodes: LinkNode[] = [leadContractor(1), leadContractor(2, { restricted: true }), leadContractor(3)].map((item) => ({ ...item, cluster: null }));
const links = [leadLink(1, 2), leadLink(2, 3, { strength: 61, status: 'STALE', evidence: [{ kind: 'ADDRESS', fingerprint: '99999999', weight: 35 }, { kind: 'PHONE', fingerprint: '88888888', weight: 40 }] })];

const draw = (focus: string | null = A) =>
  render(
    <MemoryRouter>
      <LinkGraph nodes={nodes} links={links} focusId={focus} title="Đồ thị thử" />
    </MemoryRouter>,
  );

describe('LinkGraph: the graph of related parties', () => {
  it('draws a labelled node for every contractor and an edge with its strength, and names the picture', () => {
    draw();
    const svg = screen.getByTestId('graph-svg');
    expect(svg.querySelector('title')?.textContent).toBe('Đồ thị thử');
    expect(svg.querySelector('desc')?.textContent).toBe(text('vnd3.graph.desc.text', { nodes: 3, links: 2 }));
    for (const id of [A, B, C]) expect(screen.getByTestId(`graph-node-${id}`)).toBeTruthy();
    expect(screen.getByTestId(`graph-edge-${A}:${B}`).getAttribute('data-strength')).toBe('95');
    expect(screen.getByTestId(`graph-edge-${A}:${B}`).querySelector('line')?.getAttribute('stroke-width')).toBe('6');
    expect(screen.getByTestId(`graph-edge-${B}:${C}`).querySelector('line')?.getAttribute('stroke-width')).toBe('4');
  });

  it('puts the focus in the middle and gives the same coordinates every time', () => {
    draw();
    expect(screen.getByTestId(`graph-node-${A}`).getAttribute('data-x')).toBe('280');
    expect(screen.getByTestId(`graph-node-${A}`).getAttribute('data-y')).toBe('210');
    const first = [B, C].map((id) => screen.getByTestId(`graph-node-${id}`).getAttribute('data-x'));
    cleanup();
    draw();
    expect([B, C].map((id) => screen.getByTestId(`graph-node-${id}`).getAttribute('data-x'))).toEqual(first);
  });

  it('marks a restricted contractor with the word as well as the ring, and says who is in focus, in the accessible name', () => {
    draw();
    const restricted = screen.getByTestId(`graph-node-${B}`);
    expect(restricted.textContent).toContain(word('vnd3.graph.restricted.badge'));
    expect(restricted.getAttribute('aria-label')).toBe(`Công ty nhà thầu 2, 0101234562, ${word('vnd3.graph.restricted.badge')}`);
    expect(screen.getByTestId(`graph-node-${A}`).getAttribute('aria-label')).toContain(word('vnd3.graph.focus.badge'));
    expect(screen.getByTestId(`graph-node-${C}`).textContent).not.toContain(word('vnd3.graph.restricted.badge'));
  });

  it('reads without the picture: a table lists every link with its strength and its evidence, a stale one says so', () => {
    draw();
    const table = within(screen.getByTestId('graph-table'));
    const rows = Array.from(document.querySelectorAll<HTMLElement>('tr[data-link]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Công ty nhà thầu 1');
    expect(rows[0]?.textContent).toContain('95');
    expect(rows[0]?.textContent).toContain(text('vnd3.graph.evidence.item', { kind: word('vnd3.linkKind.bankAccount.name'), weight: 95, fingerprint: 'abcdef12' }));
    expect(rows[0]?.textContent).toContain(word('vnd3.graph.status.active'));
    expect(rows[1]?.textContent).toContain(word('vnd3.graph.status.stale'));
    expect(rows[1]?.textContent).toContain(word('vnd3.linkKind.address.name'));
    expect(rows[1]?.textContent).toContain(word('vnd3.linkKind.phone.name'));
    expect(table.getAllByRole('link', { name: 'Công ty nhà thầu 1' })[0]?.getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${A}`);
  });

  it('opens the links of a contractor from the keyboard (Enter and Space) and closes them again', () => {
    draw();
    const node = screen.getByTestId(`graph-node-${B}`);
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(node.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(node, { key: 'Enter' });
    const panel = screen.getByTestId('graph-selected');
    expect(panel.textContent).toContain(text('vnd3.graph.selected.title', { name: 'Công ty nhà thầu 2' }));
    expect(panel.textContent).toContain(text('vnd3.graph.selected.item', { name: 'Công ty nhà thầu 1', strength: 95, kinds: word('vnd3.linkKind.bankAccount.name') }));
    expect(panel.textContent).toContain('Công ty nhà thầu 3');
    expect(screen.getByTestId(`graph-node-${B}`).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(screen.getByTestId(`graph-node-${B}`), { key: ' ' });
    expect(screen.queryByTestId('graph-selected')).toBeNull();
    fireEvent.click(screen.getByTestId(`graph-node-${A}`));
    expect(screen.getByTestId('graph-selected').textContent).toContain('Công ty nhà thầu 2');
  });

  it('says an isolated contractor has no link', () => {
    render(
      <MemoryRouter>
        <LinkGraph nodes={nodes} links={[leadLink(1, 2)]} focusId={null} title="Đồ thị thử" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId(`graph-node-${C}`));
    expect(screen.getByTestId('graph-selected').textContent).toContain(word('vnd3.graph.selected.none'));
  });

  it('draws the nodes and an empty table when there is no link', () => {
    render(
      <MemoryRouter>
        <LinkGraph nodes={nodes} links={[]} focusId={null} title="Đồ thị thử" />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId(/graph-node-/)).toHaveLength(3);
    expect(document.querySelectorAll('tr[data-link]')).toHaveLength(0);
  });

  it('speaks English when the language is English', () => {
    translator.setLocale('en');
    draw();
    expect(screen.getByTestId(`graph-node-${B}`).textContent).toContain('Restricted');
  });
});
