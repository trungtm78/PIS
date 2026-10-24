import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { WEB_ROUTES } from './support/web-routes.ts';
import { diffImages } from './support/diff.ts';
import type { Region } from './support/diff.ts';
import { recordMissingVisuals, upsertVisual } from './support/report.ts';
import { stackInfo } from './support/stack.ts';
import type { VisualEntry } from './support/report.ts';

const ASSETS = fileURLToPath(new URL('../../../Design/MACHVON_Design/04_Design_Assets', import.meta.url));
const OUT = fileURLToPath(new URL('./__diff__', import.meta.url));
/** AC-ST-KERNEL-031-1: at most 0.1 percent of the pixels of a screen may differ, anti-aliasing excluded. This is a target, never a tuning knob. */
const RATIO_TARGET = 0.001;
const VIEWPORT = { width: 1440, height: 1000 };
/** The prototype export lays the sidebar out statically, so the element screenshot has the height of the content. */
/** The export ran with the prototype's design-studio bar (56px, as `--studio-height`), which made the baselines 944 px high; the application has no such bar, so the capture reserves the same 56px. */
const EXPORT_STYLE = '.studio{position:static!important}.workspace-sidebar.sidebar{position:static!important}:root{--studio-height:56px!important}';
const SIDEBAR_WIDTH = 252;
const TOPBAR_HEIGHT = 54;
const STATES = ['loading', 'empty', 'error', 'denied', 'offline', 'expired'] as const;
/** `E2E_REQUIRE_VISUAL=1` turns every pending case into a failure; the final integration sets it. */
const REQUIRE_VISUAL = process.env.E2E_REQUIRE_VISUAL === '1';

// A case that fails before it could record (navigation, capture, a timeout) must not leave an earlier pass in the report:
// every visual id the test would have recorded, and did not record in this run, is written as a failure afterwards.
const CASE_IDS = new Map<string, string[]>();
function visualTest(title: string, ids: string[], body: Parameters<typeof test>[2]): void {
  CASE_IDS.set(title, ids);
  test(title, body);
}

test.afterEach(({ page }, testInfo) => {
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;
  const reason = testInfo.error?.message ?? testInfo.status ?? 'failed';
  recordMissingVisuals(CASE_IDS.get(testInfo.title) ?? [], `${reason.split(String.fromCharCode(10))[0] ?? 'failed'} (at ${page.url()})`);
});

const pathOf = (id: string): string => {
  const route = WEB_ROUTES.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`route ${id} is not in the route table`);
  return route.path;
};

const sizeOf = (file: string): { width: number; height: number } => {
  const { width, height } = PNG.sync.read(readFileSync(file));
  return { width, height };
};

/** Opens a route and captures `#screen-capture` the way work/export_screens.cjs captured the baselines. */
async function capture(page: Page, id: string, file: string, query = ''): Promise<{ implemented: boolean }> {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${pathOf(id)}${query}`);
  await page.waitForSelector('.workspace-breadcrumb');
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: EXPORT_STYLE });
  // Every route without an implementation renders NotImplementedScreen, which marks itself.
  const implemented = (await page.locator('[data-not-implemented]').count()) === 0;
  await page.locator('#screen-capture').screenshot({ path: file });
  return { implemented };
}

function record(entry: VisualEntry): void {
  upsertVisual(entry);
  if (entry.status === 'pending' && REQUIRE_VISUAL) throw new Error(`${entry.id} is pending (${entry.reason}) and E2E_REQUIRE_VISUAL=1`);
  if (entry.status === 'fail') {
    throw new Error(
      entry.reason === undefined
        ? `${entry.id}: ${entry.differentPixels} of ${entry.totalPixels} pixels differ (ratio ${entry.ratio}, target ${RATIO_TARGET}); see ${entry.diffPath}`
        : `${entry.id}: ${entry.reason}`,
    );
  }
}

function compare(id: string, actual: string, expected: string, region?: Region): VisualEntry {
  const diffPath = `${OUT}/${id.replace(/[^A-Za-z0-9-]/g, '_')}.diff.png`;
  let result;
  try {
    result = diffImages(actual, expected, { diffPath, region });
  } catch (error) {
    // Images that cannot be compared (another size) are a failed case with the reason, not a lost one.
    return { id, status: 'fail', reason: error instanceof Error ? error.message : String(error) };
  }
  const status = result.ratio <= RATIO_TARGET ? 'pass' : 'fail';
  return { id, status, ratio: result.ratio, differentPixels: result.differentPixels, totalPixels: result.totalPixels, diffPath };
}

// The mockup of these two screens is the generic prototype page (step cards for ADM-01, placeholder matrix for ADM-03);
// the application replaces that content with the real tree, form, matrix and grants table, so the whole page cannot be
// compared. What the real screen must keep from the mockup is its frame, and every region below is gated at the target
// ratio against the screen's own baseline PNG:
//   - the shell frame (sidebar with the screen's active item, top bar with its breadcrumb);
//   - the page heading (title and subtitle);
//   - ADM-01: the top-left corner of the card with its title;
//   - ADM-03: the two card titles and the right card's note callout.
// Not compared, because the real screen shows something else on purpose: the heading action buttons (the mockup's
// generic "Xuất" and "Lưu / Tiếp tục" are replaced by the screen's real actions), everything inside the cards below their
// titles (step cards and placeholder matrix against the real tree, form, role matrix and grants table), the card heights
// and the footer note (it follows the content height and names the real data scope). The ratio of the whole page is
// measured and attached to the test as an informational annotation, never as a pass criterion.
const HEADING: Region = { x: 286, y: 85, width: 520, height: 65 };
const SIDEBAR: Region = { x: 0, y: 0, width: SIDEBAR_WIDTH, height: 944 };
const TOPBAR: Region = { x: SIDEBAR_WIDTH, y: 0, width: VIEWPORT.width - SIDEBAR_WIDTH, height: TOPBAR_HEIGHT };
// NOT-01 and NOT-02 (notification inbox and details): the mockup shows four sample notifications with their body text and
// time; the API serves the title key, priority and read state only, so the content inside the cards is not compared. The
// shell frame and the page heading are. NOT-02's heading region starts at the back link above the title.
const NOTIFICATION_HEADING: Region = { x: 286, y: 85, width: 520, height: 100 };
// SAS-01, SAS-02, SAS-03 and SAS-25 (control-plane tenant list, tenant creation, tenant detail, entitlement view): the mockup is the generic prototype
// page with sample tenants and a filter bar, while the application shows the real registry rows, the creation form and the
// entitlement table, so only the frame and the heading are compared. SAS-02 starts with a back link above the title, as NOT-02
// does, and its region covers it (so does SAS-03's). The screens are opened as the system administrator (`?devUser=sysAdmin`).
const SAS_DETAIL_HEADING: Region = { x: 286, y: 85, width: 520, height: 100 };
// IAM-04 (tenant chooser): the mockup shows three generic configuration cards (Tenant, Đơn vị, Vai trò); the application shows one
// card per membership of the person, so the card names, pills and texts differ. The shell frame, the heading and the frame of the
// first card with its icon tile (above the title) are compared; the actions in the heading (the mockup's generic "Xuất" and
// "Lưu / Tiếp tục") are not, because choosing a tenant is done on each card. The sidebar is compared above and below the shortcut list of
// the open "Tài khoản & hỗ trợ" group: the baseline lists one shortcut (the prototype filters them to the screens it had), while
// navigation_architecture.json, the single source of the navigation, lists four, so the rows in between differ by design data.
const SIDEBAR_TOP: Region = { x: 0, y: 0, width: SIDEBAR_WIDTH, height: 582 };
const SIDEBAR_FOOT: Region = { x: 0, y: 828, width: SIDEBAR_WIDTH, height: 116 };
const SCREEN_REGIONS: Record<'ADM-01' | 'ADM-02' | 'ADM-03' | 'ADM-17' | 'DOC-05' | 'DOC-06' | 'DOC-07' | 'DOC-10' | 'DOC-21' | 'IAM-04' | 'IAM-09' | 'MDM-01' | 'MDM-25' | 'MDM-26' | 'MDM-27' | 'MDM-28' | 'MDM-31' | 'MDM-32' | 'MDM-33' | 'NOT-01' | 'NOT-02' | 'SAS-01' | 'SAS-02' | 'SAS-03' | 'SAS-04' | 'SAS-12' | 'SAS-13' | 'SAS-15' | 'SAS-22' | 'SAS-25', Record<string, Region>> = {
  'ADM-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
    'card-top-left': { x: 287, y: 177, width: 493, height: 63 },
  },
  // ADM-02 (users and invitations) and ADM-17 (contractor guests): the mockup is the generic prototype list with sample rows and a
  // filter bar; the application shows the real memberships with their roles, invitations and validity, so only the frame and the
  // heading are compared. The heading actions (the mockup's generic "Xuất" and "Tạo mới") are replaced by the real invitation button.
  'ADM-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'ADM-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'ADM-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
    'left-card-title': { x: 287, y: 177, width: 692, height: 60 },
    'right-card-title': { x: 999, y: 177, width: 407, height: 60 },
    'right-card-note': { x: 999, y: 177, width: 407, height: 140 },
  },
  // DOC-05 (leader digital signature): the mockup is the generic documents page (an upload box, six check rows with the sample state "Chờ kiểm tra", a preview
  // paper); the application keeps the two card titles and shows the real picker, the real checks and the real preview below them, so the frame, the heading and
  // the two card titles are compared. The screen is opened on the fixture document that waits for the leader (the doc query parameter). The heading actions are not compared.
  'DOC-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
    'left-card-title': { x: 287, y: 177, width: 692, height: 60 },
    'right-card-title': { x: 999, y: 177, width: 407, height: 60 },
  },
  // DOC-06 (numbering and organisation seal): the mockup is the generic workflow page (seven step cards, four fields, a note); the application keeps the
  // card head (title and the version pill of the document) and the seven step cards, with the real fields below, so the frame, the heading and the card
  // head are compared. The screen is opened on the fixture document that is signed and waits for a number.
  'DOC-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
    'card-head': { x: 287, y: 177, width: 1119, height: 60 },
  },
  // DOC-07 (verify signatures and certificates): the mockup is the generic review page (six check rows with sample states, an opinion box, the
  // related file with a sample paper); the application shows the real checks, the signatures table and the facts of the chosen version, and with no
  // version chosen a list to pick one, so only the frame and the heading are compared. The heading starts at the back link above the title.
  'DOC-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: NOTIFICATION_HEADING,
  },
  // DOC-10 (outgoing document register) and DOC-21 (number register and document type setup): the mockup is the generic prototype page with sample
  // rows and a filter bar (DOC-10) or placeholder fields (DOC-21); the application shows the real registers and forms, so only the frame and the
  // heading are compared. The heading actions (the mockup's generic buttons) are not compared.
  'DOC-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'DOC-21': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'IAM-04': {
    'sidebar-top': SIDEBAR_TOP,
    'sidebar-foot': SIDEBAR_FOOT,
    topbar: TOPBAR,
    heading: HEADING,
    'first-card-top': { x: 286, y: 177, width: 363, height: 70 },
  },
  // IAM-09 (my effective access): the mockup is the generic prototype page (a row of four tabs, five label and value rows, a chart, a list of
  // tasks). The shell frame and the heading are compared; the tabs have no operation behind them, so the card starts higher than in the mockup and
  // nothing below the heading is compared.
  'IAM-09': {
    'sidebar-top': SIDEBAR_TOP,
    'sidebar-foot': SIDEBAR_FOOT,
    topbar: TOPBAR,
    heading: HEADING,
  },
  // MDM-01, MDM-25, MDM-26, MDM-27, MDM-28 and MDM-32 (master data): the mockups are the generic prototype pages (cards of sample names, forms of
  // placeholder fields, a detail card, a compare table, an approval card); the application shows the real catalogues, forms, usage list, version
  // history and review queue, so only the shell frame and the heading are compared. MDM-25, 26 and 27 are detail screens: their heading starts at the
  // back link above the title. The screens that name an entry open without one and say so, which the mockup never shows.
  'MDM-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-25': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: NOTIFICATION_HEADING,
  },
  'MDM-26': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: NOTIFICATION_HEADING,
  },
  'MDM-27': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: NOTIFICATION_HEADING,
  },
  'MDM-28': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  // MDM-31 (retire an entry) starts with the back link "← Duyệt và công bố danh mục"; MDM-33 (scope of the catalogues) is a workspace screen.
  'MDM-31': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: NOTIFICATION_HEADING,
  },
  'MDM-32': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-33': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'NOT-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'NOT-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: NOTIFICATION_HEADING,
  },
  'SAS-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'SAS-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: SAS_DETAIL_HEADING,
  },
  'SAS-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: SAS_DETAIL_HEADING,
  },
  // SAS-04 (tenant theme): the mockup is the real editor of the prototype. The shell frame, the heading, the note under it and the heads of
  // the two cards (the title of the settings card; the title, the label and the platform select of the preview card) are compared; the form
  // fields differ by design (the application edits the draft of a tenant it picks from the registry, the mockup of a simulated role).
  'SAS-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
    callout: { x: 286, y: 176, width: 1120, height: 52 },
    'settings-card-title': { x: 286, y: 243, width: 500, height: 60 },
    'preview-card-head': { x: 803, y: 243, width: 603, height: 115 },
  },
  // SAS-12 (issue a license), SAS-13 (license detail) and SAS-15 (suspend and revoke): the mockups are the generic prototype page (a form of
  // placeholder fields, a detail card with a chart, a confirm card); the application shows the real form, the revision and the confirmation, so only
  // the frame and the heading are compared. SAS-13 and SAS-15 start with the back link "← Cấp license" above the title, and their region covers it.
  'SAS-12': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'SAS-13': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: SAS_DETAIL_HEADING,
  },
  'SAS-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: SAS_DETAIL_HEADING,
  },
  // SAS-22 (provisioning progress): the mockup is the generic prototype page (five step cards and a form of placeholder fields) under a back link; the
  // application shows the real timeline of the eleven steps, so only the frame and the heading (with the back link) are compared.
  'SAS-22': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: SAS_DETAIL_HEADING,
  },
  'SAS-25': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
};
/** The control-plane screens are the system administrator's; every other screen is looked at as the tenant owner. */
const CONTROL_SCREENS: readonly string[] = ['SAS-01', 'SAS-02', 'SAS-03', 'SAS-04', 'SAS-12', 'SAS-13', 'SAS-15', 'SAS-22', 'SAS-25'];
/** SAS-03 shows the tenant its address names: the fixture tenant of the API stack. */
const queryOf = (id: string): string => {
  if (id === 'DOC-05') return `?devUser=owner&doc=${stackInfo().documents.visualSubmitted}`;
  if (id === 'DOC-06') return `?devUser=owner&doc=${stackInfo().documents.visualSigned}`;
  if (!CONTROL_SCREENS.includes(id)) return '?devUser=owner';
  return id === 'SAS-03' || id === 'SAS-04' || id === 'SAS-22' ? `?devUser=sysAdmin&tenant=${stackInfo().tenants.A}` : '?devUser=sysAdmin';
};

for (const id of ['ADM-01', 'ADM-02', 'ADM-03', 'ADM-17', 'DOC-05', 'DOC-06', 'DOC-07', 'DOC-10', 'DOC-21', 'IAM-04', 'IAM-09', 'MDM-01', 'MDM-25', 'MDM-26', 'MDM-27', 'MDM-28', 'MDM-31', 'MDM-32', 'MDM-33', 'NOT-01', 'NOT-02', 'SAS-01', 'SAS-02', 'SAS-03', 'SAS-04', 'SAS-12', 'SAS-13', 'SAS-15', 'SAS-22', 'SAS-25'] as const) {
  const regionIds = Object.keys(SCREEN_REGIONS[id]).map((name) => `${id}:${name}`);
  visualTest(`${id}: the page frame regions match the baseline PNG`, regionIds, async ({ page }, testInfo) => {
    const actual = `${OUT}/${id}.actual.png`;
    const expected = `${ASSETS}/screens/${id}.png`;
    // The tenant owner (the system administrator on the control plane) sees the screen with its data (the API stack seeds the fixture tenant).
    const { implemented } = await capture(page, id, actual, queryOf(id));
    if (!implemented) {
      record({ id, status: 'pending', reason: 'the screen is not implemented yet (the route renders the fallback)' });
      return;
    }
    // The real page is taller than the mockup when it holds data: the informational ratio then covers the first rows both share.
    const shared = Math.min(sizeOf(actual).height, sizeOf(expected).height);
    const whole = compare(`${id}:whole-page`, actual, expected, { x: 0, y: 0, width: VIEWPORT.width, height: shared });
    const note =
      whole.ratio === undefined ? `${id} whole page: ${whole.reason}` : `${id} whole page (first ${shared} rows): ratio ${whole.ratio.toFixed(4)} (${whole.differentPixels} of ${whole.totalPixels} pixels); not gated`;
    testInfo.annotations.push({ type: 'informational', description: note });
    process.stdout.write(`${note}
`);
    for (const [name, region] of Object.entries(SCREEN_REGIONS[id])) record(compare(`${id}:${name}`, actual, expected, region));
  });
}

// The frame (sidebar and top bar) is the same on every screen, so ADM-01's baseline is compared region by region
// whether or not ADM-01's own content exists yet. The heights differ, hence the common height of the sidebar region.
visualTest('shell frame: sidebar and top bar of ADM-01 match the baseline regions', ['shell-frame:sidebar', 'shell-frame:topbar'], async ({ page }) => {
  const actual = `${OUT}/shell-frame.actual.png`;
  const expected = `${ASSETS}/screens/ADM-01.png`;
  await capture(page, 'ADM-01', actual);
  const height = Math.min(sizeOf(actual).height, sizeOf(expected).height);
  const sidebar = compare('shell-frame:sidebar', actual, expected, { x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  const topbar = compare('shell-frame:topbar', actual, expected, { x: SIDEBAR_WIDTH, y: 0, width: VIEWPORT.width - SIDEBAR_WIDTH, height: TOPBAR_HEIGHT });
  upsertVisual(sidebar);
  upsertVisual(topbar);
  expect.soft(sidebar.ratio ?? 1, `sidebar region: ${sidebar.differentPixels} of ${sidebar.totalPixels} pixels differ, see ${sidebar.diffPath}`).toBeLessThanOrEqual(RATIO_TARGET);
  expect.soft(topbar.ratio ?? 1, `top bar region: ${topbar.differentPixels} of ${topbar.totalPixels} pixels differ, see ${topbar.diffPath}`).toBeLessThanOrEqual(RATIO_TARGET);
});

// The state baselines (04_Design_Assets/states/web-*.png) are renders of the prototype's HOME-01 from before the Ruby
// palette: indigo buttons and selection, a sidebar with groups open, a toast. Those parts cannot match and are not
// compared; what is compared is the card itself (frame, glyph or skeleton, title and body), which the palette does not
// touch. The primary button of the message cards is left out of the region for the same reason (indigo against ruby).
const STATE_CARD: Region = { x: 517, y: 200, width: 659, height: 208 };
const STATE_SKELETON: Region = { x: 287, y: 177, width: 1119, height: 366 };

for (const state of STATES) {
  visualTest(`state demo ${state} matches the card of states/web-${state}.png`, [`state:${state}`], async ({ page }) => {
    const actual = `${OUT}/state-${state}.actual.png`;
    await capture(page, 'HOME-01', actual, `?demoState=${state}`);
    record(compare(`state:${state}`, actual, `${ASSETS}/states/web-${state}.png`, state === 'loading' ? STATE_SKELETON : STATE_CARD));
  });
}
