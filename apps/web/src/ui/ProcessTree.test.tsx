import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { ProcessTree } from './ProcessTree';
import type { ProcessTreeEdge, ProcessTreeNode } from './ProcessTree';
import { defaultExpanded, edgePath, indexOf, layoutFlow, navigate, visibleOrder } from './process-tree-model';
import type { FlowGeometry } from './process-tree-model';

const NODES: ProcessTreeNode[] = [
  { id: 'root', label: 'Tất cả gói thầu', count: 14, value: '320,00', unit: 'tỷ đồng', share: 1, health: 'attention', lateCount: 3, inFlow: false },
  { id: 'm1', label: 'Đấu thầu rộng rãi', count: 14, parentId: 'root', lane: 'Đấu thầu rộng rãi', inFlow: false },
  { id: 'new', label: 'Chưa bắt đầu', count: 2, parentId: 'm1', lane: 'Đấu thầu rộng rãi', column: 0 },
  { id: 's1', label: 'Lập hồ sơ mời thầu', count: 6, value: '128,40', unit: 'tỷ đồng', share: 0.43, health: 'late', lateCount: 2, medianDays: 6, longestDays: 19, parentId: 'm1', lane: 'Đấu thầu rộng rãi', column: 1 },
  { id: 's1h', label: 'Tạm dừng', count: 1, health: 'hold', parentId: 's1', lane: 'Đấu thầu rộng rãi', column: 1, row: 'below' },
  { id: 's2', label: 'Mở thầu', count: 0, parentId: 'm1', lane: 'Đấu thầu rộng rãi', column: 2 },
  { id: 'done', label: 'Đã ký hợp đồng', count: 5, parentId: 'm1', lane: 'Đấu thầu rộng rãi', column: 3, terminal: true, health: 'ok' },
];
const EDGES: ProcessTreeEdge[] = [
  { from: 'new', to: 's1', count: 2, kind: 'forward' },
  { from: 's1', to: 's2', count: 8, kind: 'forward' },
  { from: 's2', to: 's1', count: 1, kind: 'return' },
  { from: 's1', to: 's1h', count: 1, kind: 'return', label: 'tạm dừng 1' },
  { from: 's2', to: 'done', count: 1, kind: 'drop' },
];

const originalMatchMedia = window.matchMedia;
const mediaMatches = (value: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: value, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
});

describe('ProcessTree: the flow view', () => {
  it('draws a card for each node of the flow with the count as text, and leaves the others to the outline', () => {
    render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="Cây tiến độ" onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /Lập hồ sơ mời thầu, 6 gói thầu, giá trị 128,40 tỷ đồng, 2 trễ hạn/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tất cả gói thầu/ })).not.toBeInTheDocument();
    expect(screen.getByText('Đấu thầu rộng rãi', { selector: 'h3' })).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /Lập hồ sơ mời thầu/ });
    expect(within(card).getByText('6')).toBeInTheDocument();
    expect(card.textContent).toContain('43% tổng');
    expect(card.textContent).toContain('trung vị 6 ngày');
    expect(card.textContent).toContain('lâu nhất 19 ngày');
  });

  it('says the health with an icon and a word, never by colour alone', () => {
    render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="c" onSelect={() => undefined} />);
    const late = screen.getByRole('button', { name: /Lập hồ sơ mời thầu/ });
    expect(within(late).getByText('trễ')).toBeInTheDocument();
    expect(late.textContent).toContain('⛔');
    expect(within(screen.getByRole('button', { name: /Tạm dừng/ })).getByText('tạm dừng')).toBeInTheDocument();
  });

  it('draws the edges aria-hidden with their counts, the return dashed and the drop dotted, wider for more packages', () => {
    const { container } = render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="c" onSelect={() => undefined} />);
    const svg = container.querySelector('svg.ui-process-tree__edges') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('.ui-process-tree__edge--forward')).toHaveLength(2);
    expect(svg.querySelectorAll('.ui-process-tree__edge--return')).toHaveLength(2);
    expect(svg.querySelectorAll('.ui-process-tree__edge--drop')).toHaveLength(1);
    const text = Array.from(svg.querySelectorAll('text')).map((node) => node.textContent);
    expect(text).toEqual(expect.arrayContaining(['2 gói', '8 gói', 'trả lại 1', 'tạm dừng 1', 'hủy / không thành 1']));
    const widths = Array.from(svg.querySelectorAll('.ui-process-tree__edge--forward path')).map((path) => Number(path.getAttribute('stroke-width')));
    expect(widths).toEqual([3.1, 10]);
  });

  it('selects on click and marks the selection with aria-pressed; an empty node is shown but cannot be selected', async () => {
    const onSelect = vi.fn();
    render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="c" selectedId="s1" onSelect={onSelect} />);
    const chosen = screen.getByRole('button', { name: /Lập hồ sơ mời thầu/ });
    expect(chosen).toHaveAttribute('aria-pressed', 'true');
    const empty = screen.getByRole('button', { name: /Mở thầu, 0 gói thầu/ });
    expect(empty).toHaveAttribute('aria-disabled', 'true');
    expect(empty.textContent).toContain('0');
    await userEvent.click(empty);
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Đã ký hợp đồng/ }));
    expect(onSelect).toHaveBeenCalledWith('done');
  });

  it('moves with the arrow keys over a roving tabindex and selects with Enter and Space', async () => {
    const onSelect = vi.fn();
    render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="c" onSelect={onSelect} />);
    const buttons = screen.getAllByRole('button').filter((button) => button.hasAttribute('data-node-id'));
    expect(buttons.filter((button) => button.getAttribute('tabindex') === '0')).toHaveLength(1);
    const first = screen.getByRole('button', { name: /Chưa bắt đầu/ });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /Lập hồ sơ mời thầu/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: /Tạm dừng/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: /Lập hồ sơ mời thầu/ })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('button', { name: /Đã ký hợp đồng/ })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(first).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('s1');
    await userEvent.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('puts the canvas in a labelled region that scrolls on its own', () => {
    render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="Cây tiến độ" onSelect={() => undefined} />);
    const region = screen.getByRole('region', { name: 'Cây tiến độ' });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('uses the flow from 980 px and a 232 px column from 1280 px', () => {
    mediaMatches(true);
    const { container } = render(<ProcessTree nodes={NODES} edges={EDGES} caption="c" onSelect={() => undefined} />);
    expect(container.querySelector('.ui-process-tree--flow')).not.toBeNull();
    const card = screen.getByRole('button', { name: /Lập hồ sơ mời thầu/ });
    expect(card.style.width).toBe('232px');
  });

  it('reads the same tree as a table with the flows as sentences', async () => {
    render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="Cây tiến độ" onSelect={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Xem dạng bảng' }));
    const table = screen.getByRole('table', { name: 'Cây tiến độ' });
    const row = within(table).getByRole('rowheader', { name: 'Lập hồ sơ mời thầu' }).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['6', '128,40 tỷ đồng', '43% tổng', 'trung vị 6 ngày', '2', 'trễ']);
    expect(screen.getByText('8 gói: từ Lập hồ sơ mời thầu sang Mở thầu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Xem dạng cây' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="Cây tiến độ" onSelect={() => undefined} />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});

describe('ProcessTree: the outline', () => {
  const open = (storageKey?: string) => render(<ProcessTree nodes={NODES} edges={EDGES} view="outline" caption="Cây tiến độ" storageKey={storageKey} onSelect={() => undefined} />);

  it('is a tree of treeitems with their level, set size and expanded state, open to the second level', () => {
    open();
    const tree = screen.getByRole('tree', { name: 'Cây tiến độ' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((item) => item.getAttribute('data-node-id'))).toEqual(['root', 'm1', 'new', 's1', 's2', 'done']);
    const root = items[0] as HTMLElement;
    expect(root).toHaveAttribute('aria-level', '1');
    expect(root).toHaveAttribute('aria-expanded', 'true');
    expect(items[3]).toHaveAttribute('aria-level', '3');
    expect(items[3]).toHaveAttribute('aria-expanded', 'false');
    expect(items[2]).not.toHaveAttribute('aria-expanded');
    expect(items[3]).toHaveAttribute('aria-setsize', '4');
    expect(items[3]).toHaveAttribute('aria-posinset', '2');
  });

  it('reads each row as a sentence with the count as text', () => {
    open();
    expect(screen.getByRole('treeitem', { name: /Lập hồ sơ mời thầu, 6 gói thầu, giá trị 128,40 tỷ đồng, 2 trễ hạn, chọn để xem chi tiết/ })).toBeInTheDocument();
  });

  it('expands with the chevron and with the Right arrow, and collapses with the Left arrow', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Mở rộng Lập hồ sơ mời thầu' }));
    expect(screen.getByRole('treeitem', { name: /Tạm dừng/ })).toBeInTheDocument();
    screen.getByRole('treeitem', { name: /Lập hồ sơ mời thầu/ }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('treeitem', { name: /Tạm dừng/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('treeitem', { name: /Tạm dừng/ })).toBeInTheDocument();
  });

  it('moves to the parent, the siblings and the ends, selects with Enter, and Escape closes the branch and returns to its node', async () => {
    const onSelect = vi.fn();
    render(<ProcessTree nodes={NODES} edges={EDGES} view="outline" caption="c" onSelect={onSelect} />);
    const row = screen.getByRole('treeitem', { name: /Lập hồ sơ mời thầu/ });
    row.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /Mở thầu/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowLeft}');
    expect(screen.getByRole('treeitem', { name: /Đấu thầu rộng rãi, 14/ })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('treeitem', { name: /Đã ký hợp đồng/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('done');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('treeitem', { name: /Đã ký hợp đồng/ })).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Đấu thầu rộng rãi, 14/ })).toHaveFocus();
  });

  it('remembers the open rows for the session and nothing else', async () => {
    const first = open('prc');
    await userEvent.click(screen.getByRole('button', { name: 'Mở rộng Lập hồ sơ mời thầu' }));
    expect(JSON.parse(window.sessionStorage.getItem('ui.processTree:prc') as string)).toContain('s1');
    first.unmount();
    open('prc');
    expect(screen.getByRole('treeitem', { name: /Tạm dừng/ })).toBeInTheDocument();
  });

  it('works when the session store is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    open('prc');
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('uses the outline on a narrow window by itself', () => {
    mediaMatches(false);
    render(<ProcessTree nodes={NODES} edges={EDGES} caption="c" onSelect={() => undefined} />);
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = open();
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});

describe('ProcessTree: the states', () => {
  it('loading is a skeleton that names itself and shows no number', () => {
    render(<ProcessTree nodes={NODES} edges={EDGES} caption="c" state="loading" onSelect={() => undefined} />);
    const status = screen.getByRole('status', { name: 'Đang tải cây tiến độ' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status.textContent).not.toMatch(/\d/);
  });

  it('error names the failure and retries in place', async () => {
    const onRetry = vi.fn();
    render(<ProcessTree nodes={NODES} edges={EDGES} caption="c" state="error" onRetry={onRetry} onSelect={() => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được cây tiến độ');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('empty, with no package yet, says so and offers the action', async () => {
    const onEmptyAction = vi.fn();
    render(<ProcessTree nodes={[]} edges={[]} caption="c" emptyActionLabel="Thêm gói thầu" onEmptyAction={onEmptyAction} onSelect={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Chưa có gói thầu nào trong phạm vi');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm gói thầu' }));
    expect(onEmptyAction).toHaveBeenCalledOnce();
  });

  it('empty, when the filters found nothing, offers to clear them', async () => {
    const onClear = vi.fn();
    render(<ProcessTree nodes={[]} edges={[]} caption="c" emptyKind="filtered" onClearFilters={onClear} onSelect={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Không có gói nào khớp bộ lọc');
    await userEvent.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('partial, stale and denied are banners over nodes that stay as they were read', () => {
    render(
      <ProcessTree
        nodes={NODES}
        edges={EDGES}
        view="flow"
        caption="c"
        notices={[
          { kind: 'partial', text: 'Chưa đọc được: lịch làm việc. Có thể thiếu gói.' },
          { kind: 'stale', text: 'Số liệu cũ · cập nhật 07:05' },
          { kind: 'denied', text: 'Một số phạm vi bị ẩn' },
        ]}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual(['Chưa đọc được: lịch làm việc. Có thể thiếu gói.', 'Số liệu cũ · cập nhật 07:05', 'Một số phạm vi bị ẩn']);
    expect(screen.getByRole('button', { name: /Lập hồ sơ mời thầu, 6 gói thầu/ })).toBeInTheDocument();
  });

  it('a node whose count could not be read says so instead of 0', () => {
    render(<ProcessTree nodes={[{ id: 'a', label: 'Bước A', count: null }]} edges={[]} view="flow" caption="c" onSelect={() => undefined} />);
    const card = screen.getByRole('button', { name: /Bước A, Chưa đọc được/ });
    expect(card.textContent).not.toMatch(/\b0\b/);
  });

  it('removes the transitions of the cards and edges with reduced motion and never animates focus', () => {
    const css = readFileSync(join(__dirname, 'ui.css'), 'utf8');
    const from = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('ProcessTree (docs'));
    const block = [css.slice(from, from + 400)];
    expect(block[0]).toContain('.ui-process-tree__node');
    expect(block[0]).toContain('.ui-process-tree__edge path');
    expect(block[0]).toContain('transition: none');
    const focusRules = css.split(/\r?\n/).filter((line) => line.includes('ui-process-tree') && line.includes(':focus-visible'));
    expect(focusRules.every((line) => !line.includes('transition'))).toBe(true);
  });
});

describe('process tree model', () => {
  const index = indexOf(NODES);
  const geometry: FlowGeometry = { columnWidth: 200, gutter: 48, nodeHeight: 100, rowGap: 30, laneHeader: 30, laneGap: 40 };

  it('indexes the tree in pre-order and opens the first levels', () => {
    expect(index.order).toEqual(['root', 'm1', 'new', 's1', 's1h', 's2', 'done']);
    expect(index.depth.get('s1h')).toBe(3);
    expect([...defaultExpanded(index, 2)].sort()).toEqual(['m1', 'root']);
    expect(visibleOrder(index, new Set(['root', 'm1']))).toEqual(['root', 'm1', 'new', 's1', 's2', 'done']);
  });

  it('puts a node under its parent when the parent is unknown at the root', () => {
    const odd = indexOf([{ id: 'x', label: 'x', count: 1, parentId: 'gone' }]);
    expect(odd.order).toEqual(['x']);
  });

  it('lays the flow out by column and row inside the lanes', () => {
    const layout = layoutFlow(NODES, index, geometry);
    expect(layout.lanes.map((lane) => lane.lane)).toEqual(['Đấu thầu rộng rãi']);
    expect(layout.placed.get('s1')).toMatchObject({ x: 248, y: 30, column: 1, row: 'main' });
    expect(layout.placed.get('s1h')).toMatchObject({ x: 248, y: 160, row: 'below' });
    expect(layout.width).toBe(4 * 248 - 48);
    expect(layout.height).toBe(30 + 100 + 30 + 100);
  });

  it('draws a forward edge between columns, a vertical one between rows and a loop under the cards for a return', () => {
    const layout = layoutFlow(NODES, index, geometry);
    const forward = edgePath(layout, geometry, { from: 's1', to: 's2', count: 8, kind: 'forward' }, 8);
    expect(forward?.d.startsWith('M 448 80')).toBe(true);
    expect(forward?.width).toBe(10);
    const vertical = edgePath(layout, geometry, { from: 's1', to: 's1h', count: 1, kind: 'return' }, 8);
    expect(vertical?.d).toBe('M 348 130 V 160');
    const back = edgePath(layout, geometry, { from: 's2', to: 's1', count: 1, kind: 'return' }, 8);
    expect(back?.d).toContain('Q');
    expect(back?.width).toBe(2);
    expect(edgePath(layout, geometry, { from: 's2', to: 'gone', count: 1, kind: 'forward' }, 8)).toBeUndefined();
  });

  it('navigates by the rules of the spec', () => {
    const shown = visibleOrder(index, new Set(['root', 'm1', 's1']));
    expect(navigate(index, shown, 's1', 'ArrowRight')).toBe('s1h');
    expect(navigate(index, shown, 's1', 'ArrowLeft')).toBe('m1');
    expect(navigate(index, shown, 's1', 'ArrowDown')).toBe('s2');
    expect(navigate(index, shown, 'new', 'ArrowUp')).toBe('new');
    expect(navigate(index, shown, 's2', 'Home')).toBe('root');
    expect(navigate(index, shown, 's2', 'End')).toBe('done');
    expect(navigate(index, shown, 'missing', 'End')).toBe('missing');
  });
});

it('fires no select from a disabled card when pressed with the keyboard', () => {
  const onSelect = vi.fn();
  render(<ProcessTree nodes={NODES} edges={EDGES} view="flow" caption="c" onSelect={onSelect} />);
  const empty = screen.getByRole('button', { name: /Mở thầu, 0 gói thầu/ });
  fireEvent.keyDown(empty, { key: 'Enter' });
  expect(onSelect).not.toHaveBeenCalled();
});
