import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { routeById } from '../../routes/registry';
import { screenModules } from '../../routes/screens/index';
import type { WebRoute } from '../../routes/types';
import { ICON_PATHS } from '../../shell/icons';
import AdvisoryScreen from './AdvisoryScreen';
import { ADVISORY_IDS, advisoryContent } from './advisory-content';

const routeOf = (id: string): WebRoute => {
  const route = routeById(id);
  if (route === undefined) throw new Error(`no route ${id}`);
  return route;
};

/** Draws a page on one of its tabs: the mockup is the first tab, the explanation is `?view=intro`. */
function mount(id: string, tab: 'screen' | 'intro' = 'screen') {
  const view = render(
    <MemoryRouter initialEntries={[tab === 'intro' ? '/?view=intro' : '/']}>
      <AdvisoryScreen route={routeOf(id)} />
    </MemoryRouter>,
  );
  const page = view.container.querySelector(`[data-screen-id="${id}"]`) as HTMLElement;
  const panel = (name: 'screen' | 'intro'): HTMLElement => within(page).getByTestId(`adv-panel-${name}`);
  return { ...view, page, panel };
}

const SECTIONS = ['adv.section.features.title', 'adv.section.data.title', 'adv.section.steps.title', 'adv.section.benefits.title'] as const;
const advKeys = Object.keys(vi_).filter((key) => key.startsWith('adv.'));
/** The keys of the mockups hold the example figures; the others are the explanation, which holds none. */
const isMockKey = (key: string): boolean => /^adv\.(m\d|mock)\./.test(key);
const textOf = (catalogue: Record<string, string>, keys: readonly string[]): string => keys.map((key) => catalogue[key] ?? '').join('\n');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('the explanatory pages of the advisory group (ADV-01 to ADV-05)', () => {
  it.each(ADVISORY_IDS)('AC-ST-ADV-001-2 / UI-%s: says in words that the function will be deployed and fills every section of the explanation', (id) => {
    const route = routeOf(id);
    const { container, page, panel } = mount(id, 'intro');
    expect(page).not.toBeNull();
    // One page title, which is the title of the route.
    const titles = within(page).getAllByRole('heading', { level: 1 });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveTextContent(route.title);
    expect(page).toHaveAttribute('aria-labelledby', titles[0]?.id);
    // The status is text above the tabs, and the note says the function is not in use yet.
    expect(within(page).getByText(vi_['adv.page.status.label']).closest('.ui-pill')).not.toBeNull();
    expect(within(page).getByRole('note')).toHaveTextContent(vi_['adv.page.status.note']);
    expect(within(page).getByRole('tab', { name: vi_['adv.tabs.intro.label'] })).toHaveAttribute('aria-selected', 'true');
    const intro = panel('intro');
    expect(intro).not.toHaveAttribute('hidden');
    // Every section has its heading and at least one line; no line is empty.
    for (const key of SECTIONS) {
      const section = within(intro).getByRole('region', { name: vi_[key] });
      const lines = within(section).getAllByRole('listitem');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) expect((line.textContent ?? '').trim().length).toBeGreaterThan(20);
    }
    expect(within(within(intro).getByRole('region', { name: vi_['adv.section.features.title'] })).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect((container.querySelector('.adv-summary')?.textContent ?? '').length).toBeGreaterThan(80);
    // The steps are in order; the icon of the page is decoration.
    expect(within(intro).getByRole('region', { name: vi_['adv.section.steps.title'] }).querySelector('ol')).not.toBeNull();
    expect(container.querySelector('.adv-head__icon svg')).toHaveAttribute('aria-hidden', 'true');
    // The explanation is text: nothing to fill in, nothing to press, no table of figures.
    expect(intro.querySelectorAll('button, input, select, textarea, form, table, a')).toHaveLength(0);
  });

  it.each(ADVISORY_IDS)('AC-ST-ADV-001-2 / UI-%s: opens on the mockup, marked as a planned screen with example figures, with no empty block', (id) => {
    const { page, panel } = mount(id);
    const tabs = within(page).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([vi_['adv.tabs.screen.label'], vi_['adv.tabs.intro.label']]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const mock = panel('screen');
    expect(mock).not.toHaveAttribute('hidden');
    expect(panel('intro')).toHaveAttribute('hidden');
    // The status stays above the tabs, and the mockup says its figures are examples.
    expect(within(page).getByText(vi_['adv.page.status.label'])).toBeVisible();
    expect(within(mock).getByTestId('adv-example-note')).toHaveTextContent(vi_['adv.mock.example.note']);
    expect(vi_['adv.mock.example.note']).toBe('Màn hình dự kiến, số liệu ví dụ');
    // At least three blocks, each with a heading and content.
    const blocks = within(mock).getAllByRole('region').filter((region) => region.classList.contains('ui-section'));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      expect(within(block).getAllByRole('heading', { level: 2 })).toHaveLength(1);
      expect((block.querySelector('.ui-section__body')?.textContent ?? '').trim().length).toBeGreaterThan(30);
    }
    // A chart has a name that says what it shows; every other svg is decoration.
    for (const svg of mock.querySelectorAll('svg')) {
      if (svg.getAttribute('role') === 'img') expect((svg.getAttribute('aria-label') ?? '').length).toBeGreaterThan(40);
      else expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
    // A table scrolls in a named region the keyboard reaches, and has three to five rows.
    for (const region of mock.querySelectorAll('.adv-table-wrap')) {
      expect(region).toHaveAttribute('tabindex', '0');
      expect((region.getAttribute('aria-label') ?? '').length).toBeGreaterThan(5);
      const rows = region.querySelectorAll('tbody tr').length;
      expect(rows).toBeGreaterThanOrEqual(3);
      expect(rows).toBeLessThanOrEqual(5);
    }
    // Nothing leaves the page and nothing is sent: no link, no form, and every button says its type.
    expect(mock.querySelectorAll('a, form')).toHaveLength(0);
    for (const button of mock.querySelectorAll('button')) expect(button).toHaveAttribute('type', 'button');
  });

  it('moves between the two tabs and keeps the status above both', () => {
    const { page, panel } = mount('ADV-03');
    fireEvent.click(within(page).getByRole('tab', { name: vi_['adv.tabs.intro.label'] }));
    expect(panel('intro')).not.toHaveAttribute('hidden');
    expect(panel('screen')).toHaveAttribute('hidden');
    expect(within(page).getByText(vi_['adv.page.status.label'])).toBeVisible();
    fireEvent.click(within(page).getByRole('tab', { name: vi_['adv.tabs.screen.label'] }));
    expect(panel('screen')).not.toHaveAttribute('hidden');
  });

  it('ADV-01 mockup: an inert question box, three ranked recommendations, three scenarios, and what each plan opens in words', () => {
    const { panel } = mount('ADV-01');
    const mock = panel('screen');
    const box = within(mock).getByRole('textbox', { name: vi_['adv.m1.ask.label'] });
    expect(box).toHaveAttribute('readonly');
    expect(within(mock).getByRole('button', { name: vi_['adv.m1.ask.send'] })).toBeDisabled();
    // A suggested question only changes what the box shows.
    expect(box).toHaveValue(vi_['adv.m1.q1.text']);
    fireEvent.click(within(mock).getByRole('button', { name: vi_['adv.m1.q2.text'] }));
    expect(box).toHaveValue(vi_['adv.m1.q2.text']);
    expect(within(mock).getByRole('button', { name: vi_['adv.m1.q2.text'] })).toHaveAttribute('aria-pressed', 'true');
    const recs = within(mock).getByRole('region', { name: vi_['adv.m1.recs.title'] });
    expect(within(recs).getAllByRole('listitem')).toHaveLength(3);
    expect(recs).toHaveTextContent(vi_['adv.m1.rec1.conf']);
    const chart = within(mock).getByRole('img', { name: vi_['adv.m1.chart.alt'] });
    expect(chart.closest('figure')).toHaveTextContent(vi_['adv.m1.scen1.name']);
    expect(chart.closest('figure')).toHaveTextContent(vi_['adv.m1.scen3.name']);
    // The plans: five blocks each, a lock said in words, and no price.
    const tiers = within(mock).getByRole('region', { name: vi_['adv.m1.tiers.title'] });
    expect(within(tiers).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Tiêu chuẩn', 'Chuyên sâu', 'Cao cấp']);
    const states = [...tiers.querySelectorAll('.adv-tier')].map((tier) => [...tier.querySelectorAll('em')].map((state) => state.textContent));
    const open = vi_['adv.mock.state.open'];
    const locked = vi_['adv.mock.state.locked'];
    expect(states).toEqual([
      [open, open, locked, locked, locked],
      [open, open, open, open, locked],
      [open, open, open, open, open],
    ]);
  });

  it('ADV-02 to ADV-05 mockups: the blocks the design names are there', () => {
    const blocksOf = (id: string): (string | null)[] => {
      cleanup();
      return [...mount(id).panel('screen').querySelectorAll('.ui-section__title')].map((title) => title.textContent);
    };
    expect(blocksOf('ADV-02')).toEqual([vi_['adv.m2.experts.title'], vi_['adv.m2.week.title'], vi_['adv.m2.flow.title'], vi_['adv.m2.session.title']]);
    expect(screen.getByText(vi_['adv.m2.fee.note'])).toBeInTheDocument();
    // Choosing an expert changes the session shown, nothing else.
    fireEvent.click(screen.getAllByRole('button', { name: vi_['adv.m2.exp.pick'] })[0] as HTMLElement);
    expect(screen.getByText(vi_['adv.m2.session.when'].replace('{expert}', vi_['adv.m2.exp2.name']))).toBeInTheDocument();
    expect(blocksOf('ADV-03')).toEqual([vi_['adv.m3.kpi.title'], vi_['adv.m3.matrix.title'], vi_['adv.m3.draft.title']]);
    expect(screen.getByRole('img', { name: vi_['adv.m3.matrix.alt'] })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: vi_['adv.m3.draft.steps'] }).querySelectorAll('li')).toHaveLength(4);
    expect(blocksOf('ADV-04')).toEqual([vi_['adv.m4.lanes.title'], vi_['adv.m4.bars.title'], vi_['adv.m4.changes.title']]);
    expect(screen.getByText(vi_['adv.m4.lane.total'].replace('{days}', '60'))).toBeInTheDocument();
    expect(screen.getByText(vi_['adv.m4.lane.total'].replace('{days}', '34'))).toBeInTheDocument();
    expect(screen.getByText(vi_['adv.m4.lane.gap'].replace('{days}', '26'))).toBeInTheDocument();
    expect(blocksOf('ADV-05')).toEqual([vi_['adv.m5.catalog.title'], vi_['adv.m5.calendar.title'], vi_['adv.m5.radar.title'], vi_['adv.m5.progress.title']]);
    expect(screen.getByRole('img', { name: vi_['adv.m5.radar.alt'] })).toBeInTheDocument();
  });

  it('AC-ST-ADV-001-2: ADV-01 lists the free plan and the two plans paid monthly, with no price', () => {
    const { panel } = mount('ADV-01', 'intro');
    const plans = within(panel('intro')).getByRole('region', { name: vi_['adv.section.plans.title'] });
    const names = within(plans)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(['Tiêu chuẩn', 'Chuyên sâu', 'Cao cấp']);
    const fees = [...plans.querySelectorAll('.adv-plan__fee')].map((fee) => fee.textContent);
    expect(fees).toEqual(['Miễn phí', vi_['adv.ai.plan.paid.fee'], vi_['adv.ai.plan.paid.fee']]);
    expect(vi_['adv.ai.plan.paid.fee']).toContain('theo thỏa thuận khi triển khai');
    expect(within(plans).getByText(vi_['adv.ai.plan.note.text'])).toBeInTheDocument();
    for (const plan of plans.querySelectorAll('.adv-plan')) expect((plan.lastElementChild?.textContent ?? '').length).toBeGreaterThan(40);
    expect(screen.queryByRole('region', { name: vi_['adv.section.fee.title'] })).toBeNull();
  });

  it('AC-ST-ADV-001-2: ADV-02 says the fee is paid through the partner, and only ADV-01 has plans', () => {
    mount('ADV-02', 'intro');
    const fee = screen.getByRole('region', { name: vi_['adv.section.fee.title'] });
    expect(fee).toHaveTextContent(vi_['adv.expert.fee.p1']);
    expect(fee).toHaveTextContent('qua đối tác');
    expect(screen.queryByRole('region', { name: vi_['adv.section.plans.title'] })).toBeNull();
    for (const id of ['ADV-03', 'ADV-04', 'ADV-05']) {
      cleanup();
      mount(id, 'intro');
      expect(screen.queryByRole('region', { name: vi_['adv.section.plans.title'] })).toBeNull();
      expect(screen.queryByRole('region', { name: vi_['adv.section.fee.title'] })).toBeNull();
    }
  });

  it('AC-ST-ADV-001-2: the explanation holds no figure and no price, and no text holds an English word of the plans or a currency other than the dong', () => {
    const intro = textOf(vi_, advKeys.filter((key) => !isMockKey(key)));
    // The only number the explanation may say is the name of the scheme the owner named.
    expect(intro.replace(/Đề án 57/g, '')).not.toMatch(/\d/);
    expect(intro).not.toMatch(/VND|USD|triệu|tỷ đồng|%/);
    expect(intro).toContain('Đề án 57');
    const all = textOf(vi_, advKeys);
    expect(all).not.toMatch(/\b(Standard|Pro|Premium|dashboard|workflow|mockup)\b/i);
    expect(all).not.toMatch(/USD|\$|giá gói|đồng\/tháng/);
  });

  it('has every line in both catalogues, and draws the page in English when the language is English', () => {
    for (const key of advKeys) expect((en as Record<string, string>)[key], key).toBeTruthy();
    expect(Object.keys(en).filter((key) => key.startsWith('adv.')).sort()).toEqual([...advKeys].sort());
    translator.setLocale('en');
    mount('ADV-03');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(en['adv.strategy.page.title']);
    expect(screen.getByText(en['adv.page.status.label'])).toBeInTheDocument();
    expect(screen.getByTestId('adv-example-note')).toHaveTextContent(en['adv.mock.example.note']);
  });

  it('gives each page its own icon of the shell set and a title equal to the title of its route', () => {
    const icons = ADVISORY_IDS.map((id) => advisoryContent(id, translator.t)?.icon);
    expect(icons).toEqual(['chip', 'expert', 'compass', 'flowEdit', 'graduation']);
    for (const icon of icons) expect(Object.keys(ICON_PATHS)).toContain(icon);
    for (const id of ADVISORY_IDS) expect(advisoryContent(id, translator.t)?.title).toBe(routeOf(id).title);
    expect(advisoryContent('PRJ-01', translator.t)).toBeUndefined();
  });

  it('is the registered screen of the five routes, and falls back to the not-implemented page for any other route', async () => {
    for (const id of ADVISORY_IDS) {
      const loaded = await screenModules[id]?.();
      expect(loaded?.default).toBe(AdvisoryScreen);
      expect(routeOf(id)).toMatchObject({ module: 'ADV', path: `/adv/${id.toLowerCase()}`, area: 'advisory' });
    }
    const { container } = render(
      <MemoryRouter>
        <AdvisoryScreen route={routeOf('PRJ-01')} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-not-implemented]')).not.toBeNull();
  });
});
