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
// MDM-24 (cross-system code mapping) and MDM-34 (business glossary): the mockups keep the generic subtitle of the prototype, the application states what the screen is in a sentence or two, so only the title (no subtitle) is compared.
const TITLE_ONLY: Region = { x: 286, y: 85, width: 520, height: 40 };
// A detail screen whose subtitle differs from the mockup's generic one: the back link above the title and the title are compared, the subtitle is not.
const BACKLINK_TITLE_ONLY: Region = { x: 286, y: 85, width: 520, height: 75 };
const SIDEBAR_TOP: Region = { x: 0, y: 0, width: SIDEBAR_WIDTH, height: 582 };
const SIDEBAR_FOOT: Region = { x: 0, y: 828, width: SIDEBAR_WIDTH, height: 116 };
const SCREEN_REGIONS: Record<'ADM-01' | 'ADM-02' | 'ADM-07' | 'ADM-09' | 'ADM-10' | 'ADM-11' | 'ADM-12' | 'ADM-15'| 'ADM-03' | 'ADM-05' | 'ADM-17' | 'BID-01' | 'BID-02' | 'BID-03' | 'BID-04' | 'BID-05' | 'BID-15' | 'BID-16' | 'BID-17' | 'BID-18' | 'BID-19' | 'BID-20' | 'DGV-01' | 'DGV-03' | 'DGV-04' | 'DGV-06' | 'DGV-07' | 'DOC-02' | 'DOC-03' | 'DOC-04' | 'DOC-05' | 'DOC-06' | 'DOC-07' | 'DOC-08' | 'DOC-09' | 'DOC-10' | 'DOC-14' | 'DOC-19' | 'DOC-21' | 'IAM-04' | 'IAM-08' | 'IAM-09' | 'LND-01' | 'LND-02' | 'LND-10' | 'LND-11' | 'ISS-01' | 'ISS-02' | 'ISS-03' | 'ISS-04' | 'ISS-07' | 'ISS-09' | 'ISS-10' | 'MDM-01' | 'MDM-02' | 'MDM-03' | 'MDM-04' | 'MDM-05' | 'MDM-06' | 'MDM-07' | 'MDM-08' | 'MDM-09' | 'MDM-10' | 'MDM-11' | 'MDM-12' | 'MDM-13' | 'MDM-14' | 'MDM-15' | 'MDM-16' | 'MDM-17' | 'MDM-18' | 'MDM-19' | 'MDM-20' | 'MDM-21' | 'MDM-22' | 'MDM-23' | 'MDM-24' | 'MDM-25' | 'MDM-29' | 'MDM-26' | 'MDM-27' | 'MDM-28' | 'MDM-31' | 'MDM-32' | 'MDM-33' | 'MDM-34' | 'MDM-37' | 'MNE-01' | 'MNE-02' | 'NOT-01' | 'NOT-02' | 'NOT-03' | 'NOT-11' | 'NOT-12' | 'NOT-13' | 'NOT-17' | 'PMT-01' | 'PMT-02' | 'PMT-03' | 'PMT-04' | 'PMT-05' | 'PMT-06' | 'PRJ-01' | 'PRJ-02' | 'PRJ-03' | 'PRJ-09' | 'PRJ-10' | 'PRJ-14' | 'PRJ-15' | 'PRJ-17' | 'PRJ-18' | 'PRJ-21' | 'PAY-13' | 'CAP-01' | 'CAP-02' | 'CAP-03' | 'CAP-04' | 'CAP-05' | 'CAP-06' | 'CAP-07' | 'CAP-08' | 'CAP-10' | 'CAP-11' | 'CAP-14' | 'CAP-15' | 'CAP-16' | 'CAP-17' | 'CAP-20' | 'CTR-03' | 'CTR-04' | 'CTR-05' | 'CTR-07' | 'CTR-08' | 'CTR-10' | 'CTR-19' | 'CTR-20' | 'CTR-22' | 'CTR-26' | 'DIS-14' | 'DIS-22' | 'SAS-01' |'SAS-02' | 'SAS-03' | 'SAS-04' | 'SAS-06' | 'SAS-07' | 'SAS-08' | 'SAS-11' | 'SAS-12' | 'SAS-13' | 'SAS-14' | 'SAS-16' | 'SAS-15' | 'SAS-22' | 'SAS-25' | 'QMS-04' | 'QMS-05' | 'QMS-07' | 'AST-01' | 'AST-02' | 'CTR-12' | 'PAY-10' | 'PAY-01' | 'PAY-02' | 'PAY-03' | 'CTR-13' | 'PAY-07' | 'CTR-06' | 'PAY-04' | 'PAY-14' | 'PAY-05' | 'PAY-06' | 'PAY-09' | 'PAY-08' | 'PAY-15' | 'PAY-17', Record<string, Region>> = {
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
  // ADM-07 (working calendar) and ADM-15 (approval authority matrix): the mockups keep the generic subtitle of the prototype and a
  // sample list; the application states what the screen is, shows the month grids and the real versions, so the frame and the title
  // (no subtitle) are compared.
  'ADM-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ADM-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // ADM-09 (connectors), ADM-10 (sync monitor), ADM-11 (audit log) and ADM-12 (retention rules): the mockups keep the generic subtitle of the prototype and
  // a generic form or list; the application states what the screen is and shows the real rows, so the frame and the title (no subtitle) are compared.
  'ADM-09': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ADM-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ADM-11': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ADM-12': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ADM-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'ADM-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ADM-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
    'left-card-title': { x: 287, y: 177, width: 692, height: 60 },
    'right-card-title': { x: 999, y: 177, width: 407, height: 60 },
    'right-card-note': { x: 999, y: 177, width: 407, height: 140 },
  },
  // BID-01 (contractor list) and BID-02 (contractor profile): the mockups keep the generic subtitle of the prototype and a sample list or card; the application
  // states what the registry is and shows the real contractors, verification and restrictions, so the frame and the title are compared. BID-02 opens without a
  // contractor (the address names none) and says so; its title is the one of the mockup, under the back link to the list.
  'BID-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'BID-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    // The back link and the title, without the generic subtitle of the mockup (the open profile shows the name of the contractor as its title).
    heading: { x: 286, y: 85, width: 520, height: 75 },
  },
  // BID-03 (packages), BID-15 (procurement plans) and BID-16 (plan editor): the mockups keep the generic subtitle of the prototype and a sample table or form; the
  // application states the rule of the plan and shows the real plans, so the frame and the title are compared.
  'BID-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // BID-04 (evaluation criteria): the mockup is the generic prototype page with a sample table; the application shows the real versions and the editor.
  'BID-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'BID-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'BID-16': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    // The back link and the title, without the generic subtitle of the mockup.
    heading: { x: 286, y: 85, width: 520, height: 75 },
  },
  // DGV-03 (owners and stewards) and DGV-04 (data catalogue): the mockups keep the generic subtitle of the prototype; the application states the rule of the pair
  // and of the visibility, so only the title is compared with the frame.
  // DGV-01 (control dashboard), DGV-06 (quality rules) and DGV-07 (profiling and score): the frame and the title; the application adds the rule of what is not assessed.
  'DGV-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'DGV-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'DGV-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'DGV-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'DGV-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  // DOC-02 (compose an outgoing document), DOC-03 (the list) and DOC-04 (review): the mockups are the generic editor, table and approval pages with sample
  // fields and rows; the application shows the real form, rows and checklist, so only the frame and the title are compared (the subtitle of the mockup is sample text).
  'DOC-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'DOC-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'DOC-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  // DOC-08 (issue and distribution): the mockup is the generic table page (a sample table of recipients and channels); the application shows the document picker, the issue
  // form, the dispatch form and the real table of distributions, so only the frame and the title are compared (the subtitle of the mockup is sample text).
  'DOC-08': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // DOC-09 (documents signed outside the system): the mockup is the generic import page (a drop zone, a mapping step, sample rows); the application shows the real file
  // picker, the verdict of the signatures and the two ways to attach the file, so only the frame and the title are compared; it starts with a back link above the title
  // (its parent is DOC-08), as ISS-02 does, and its region covers it.
  'DOC-09': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // DOC-10 (outgoing document register) and DOC-21 (number register and document type setup): the mockup is the generic prototype page with sample
  // rows and a filter bar (DOC-10) or placeholder fields (DOC-21); the application shows the real registers and forms, so only the frame and the
  // heading are compared. The heading actions (the mockup's generic buttons) are not compared.
  'DOC-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  // DOC-19 (recall, replacement and correction): the mockup is the generic timeline page (a sample list of events); the application shows the real document picker, the
  // recall and void forms, the notices to the recipients and the timeline of the chosen document, so only the frame and the title are compared (the subtitle of the mockup is sample text); it starts with a back link to the register above the title, and its region covers it.
  'DOC-19': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // DOC-14 (template library): the mockup is the generic prototype page with a filter bar and sample rows; the application states the three separate steps in its
  // subtitle and shows the real revisions, so only the frame and the title are compared.
  'DOC-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  // IAM-08 (help and support requests): the mockup is the generic prototype page with a checklist of the field names; the application shows the real list of tickets and the form, so only the title is compared. This screen is the first shortcut of the open "Tài khoản & hỗ trợ" group, whose rows the baseline filters, so the top of the sidebar is compared down to the group's own row.
  'IAM-08': {
    'sidebar-top': { x: 0, y: 0, width: SIDEBAR_WIDTH, height: 548 },
    'sidebar-foot': SIDEBAR_FOOT,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  // ISS-01 (issue board), ISS-02 (report an issue) and ISS-03 (issue workspace): the mockups are the generic prototype pages (a board of sample cards, a form of
  // placeholder fields, a detail card); the application shows the real board by status, the form with the rules that apply and the workspace with its SLA
  // and timeline, and states what each screen is in its subtitle, so only the frame and the title are compared. ISS-02 and ISS-03 start with a back link
  // above the title (their region covers it); ISS-03 is looked at without an issue named, so its title is the name of the screen.
  'ISS-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'ISS-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'ISS-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // ISS-04 (escalation and extension) and ISS-07 (verification and closing): like ISS-03, looked at without an issue named, with the back link above the title.
  'ISS-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'ISS-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // ISS-09 (SLA policies): like MDM-24, the mockup keeps the generic subtitle of the prototype, so only the title is compared.
  'ISS-09': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // ISS-10 (escalation board): the board lists live escalations, so the frame and the title are compared; the subtitle states what each screen is.
  'ISS-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'MDM-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  // MDM-02 and MDM-03 (areas and agencies with their successors): the subtitle names the date the structure is read at, so only the title is compared with the frame.
  'MDM-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'MDM-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // MDM-04 to MDM-10 (the catalogues of the capital chain): the mockups hold one sample form or table; the application shows the real entries and
  // rules, so the shell frame and the heading (title, subtitle, actions) are compared.
  'MDM-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-08': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-09': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-11': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-12': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-13': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-16': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-18': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-19': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-20': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-21': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-22': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-23': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
  'MDM-24': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  'MDM-29': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: HEADING,
  },
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
  'MDM-34': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // MDM-37 (inheritance tree of the 2025 reform): the mockup keeps the generic subtitle of the prototype; the application states what the two columns are,
  // so only the title is compared with the frame.
  'MDM-37': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // MNE-01 (filing calendar) and MNE-02 (report form catalogue): the mockups are the generic prototype pages with a sample calendar or table; the application states
  // what the calendar and the catalogue are (dated legal data, the CXN label) in its subtitle and shows the real obligations and revisions, so only the title is compared.
  'MNE-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'MNE-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  // NOT-11 (send queue), NOT-12 (send journey) and NOT-13 (failed queue and replay): the mockups are the generic prototype pages with the field names of the screen as a
  // checklist; the application shows the real attempts, the retry milestones and the replay panel, and states the rule of the five sends in its subtitle, so only the title is compared.
  'NOT-11': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'NOT-12': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'NOT-13': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // NOT-03 (preferences): the mockup is the generic prototype page with the field names of the screen as a checklist; the application shows the real matrix of channels, the
  // digest modes and the quiet hours, so only the title is compared.
  'NOT-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // NOT-17 (the consent history): the mockup is the generic prototype page with the field names of the screen as a checklist; the application shows the locked inbox, the form
  // that gives a consent and the real history, so only the title is compared.
  'NOT-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PMT-01 (legal dossier of a project) and PMT-02 (a permit with its milestone timeline): the mockups are the generic prototype pages with a checklist of the field names and a preview card; the application shows the real dossiers and the real permit, and states what each screen is in its subtitle, so only the title is compared. PMT-02 starts with a back link above the title (its region covers it); it is looked at without a permit named, so its title is the name of the screen.
  'PMT-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PMT-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // PMT-03 (permit type catalogue): the mockup is the generic prototype page with a checklist of the field names and a preview card; the application shows the real catalogue and the publishing form. Like MDM-24, only the title is compared: the subtitle states what the catalogue is (dated legal data) instead of the generic one.
  'PMT-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PMT-04 (gate rules and their evaluation): the mockup is the generic prototype page; the application shows the real rules, the evaluation of a project and the publishing form, so only the title is compared.
  'PMT-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PMT-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PMT-06 (waivers of the permit gates): the mockup is the generic prototype page with a checklist of the field names; the application shows the real waivers and the form, so only the title is compared.
  'PMT-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PRJ-01 (project register), PRJ-02 (create a project) and PRJ-03 (project workspace): the mockups are the generic prototype pages with sample rows or
  // placeholder fields; the application shows the real register, the form with the suggested group and the profile, and states what each screen is in
  // its subtitle, so only the title is compared. PRJ-02 and PRJ-03 start with a back link above the title (their region covers it). PRJ-03 is looked at
  // without a project named, so its title is the name of the screen; with one it is the code and the name of the project.
  'PRJ-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PRJ-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'PRJ-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // PRJ-09 (policy proposal), PRJ-10 (appraisal decision) and PRJ-15 (appraisal scoring): the mockups are the generic prototype pages with sample fields or a
  // placeholder grid, while the application shows the proposal form with the summary of the project, the sheets with the decision form and the grid of the
  // criteria; each states what the screen is in its subtitle, so only the frame and the title are compared. They are looked at without a project named,
  // so the title is the name of the screen and there is no back link above it (with a project there is one, to its workspace).
  'PRJ-09': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PRJ-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PRJ-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PRJ-17 (leaders in charge) and PRJ-18 (task forces): the mockups are the generic prototype table and list with sample rows; the application shows the form
  // of the office that administers assignments and the register or the forces with their terms, and states what the screen is in its subtitle, so only the
  // frame and the title are compared.
  'PRJ-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PRJ-18': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PRJ-21 (national project codes): the mockup is the generic prototype page with a reconciliation checklist; the application shows the adapter badge, the
  // projects with their codes and the assignment dialog, and states what the screen is in its subtitle, so only the frame and the title are compared.
  'PRJ-21': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // BID-05 (receive proposals): the mockup is the generic import page of the prototype; the application asks for a package first and then lists the proposals it may show with the declaration of conflict of
  // interest, so only the frame and the title are compared.
  'BID-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // BID-17 (invitation and selection milestones): the mockup is the generic timeline page of the prototype; the application lists the packages of the plans in force with their milestones and
  // sources, so only the frame and the title are compared.
  'BID-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // BID-18 (approve the result of the selection): the mockup is the generic approval page of the prototype with sample fields; the application asks for a package first and then lists the results
  // with what each decision rests on, so only the frame and the title are compared.
  'BID-18': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // BID-19 (bidding portal links and reconciliation): the mockup is the generic import page of the prototype; the application shows the proposal adapter, the file panel and the links with
  // their differences, so only the frame and the title are compared.
  'BID-19': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // LND-01 (land clearance overview): the mockup is the generic dashboard page of the prototype; the application asks for a project first and then shows the counts of the server, the late stages and
  // the sections, so only the frame and the title are compared.
  'LND-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // LND-11 (progress when the land fund centre executes): the mockup is the generic board page of the prototype; the application asks for a project first and then lists the stages with their executor,
  // mode, parcels, progress and status, so only the frame and the title are compared.
  'LND-11': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // LND-02 (parcels and boundaries): the mockup is the generic map page of the prototype; the application asks for a project first and then lists its parcels with
  // the timer of the notice, so only the frame and the title are compared.
  'LND-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PRJ-14 (project bank): the mockup is the generic board page of the prototype; the application shows a column for each stage, so only the frame and the title are compared.
  'PRJ-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-13 (Treasury statement import): the mockup keeps the generic subtitle of the prototype and a file chooser with a column of pending checks; the application opens on the form, the adapter verdict and the result of an import, so only the frame and the title are compared.
  'PAY-13': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CAP-04 (fund source tree), CAP-14 (support and revenue increase) and CAP-16 (appropriation book): the mockups keep the generic subtitle of the
  // prototype, the application states what the screen holds, so only the title is compared with the frame.
  // CAP-01 (plans), CAP-02 (propose capital), CAP-03 (annual plan) and CAP-06 (allocation grid): the mockups keep the generic subtitle of the prototype and
  // sample rows; the application shows the plans, the lines and the form of the tenant and says in a sentence what each holds, so the frame and the title are compared.
  'CAP-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CAP-02 is a detail of CAP-01: the mockup carries the link back to the plans above the title.
  'CAP-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'CAP-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CAP-05 (capital decisions) and CAP-10 (plan approval): the mockups keep the generic subtitle of the prototype and sample rows; the application lists the decisions
  // and the revision of the tenant and says in a sentence what each screen holds, so the frame and the title are compared.
  'CAP-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-08': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CAP-16': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CAP-11 (year close): the mockup is the generic form page (the field names and a sample document); the application shows the state of the year, its actions and the years under control,
  // so only the frame and the title are compared.
  'CAP-11': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CAP-17 (availability control): the mockup is the generic policy page (six checkboxes of the field names and a sample document); the application shows the real versions, the form with
  // the two threshold bars and the preview, so only the frame and the title are compared.
  'CAP-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CAP-20 (extension of the disbursement): the mockup is the generic form page (the field names and a sample document); the application shows the form with the figures of the line and
  // the list of the requests, so only the frame and the title are compared.
  'CAP-20': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CTR-03 (the workspace of a contract): the mockup shows sample facts and conditions; the application opens without a contract (the address names none) and says so, with the title of
  // the mockup, so the frame and the title are compared.
  'CTR-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // LND-10 (site handover by section and km): the mockup shows sample fields; the application asks for a project first and then lists the sections with their areas, so the frame
  // and the title are compared.
  'LND-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CTR-07 (change request), CTR-19 (chain of changes) and CTR-20 (tiers of a project): the mockups show sample fields; the application opens without a contract or a project (the address
  // names none) and asks for one, with the title of the mockup, so the frame and the title are compared.
  'CTR-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CTR-08 (compare and approve an annex) and CTR-26 (revisions of a contract) are detail screens: the back link above the title and the title are compared, with no change order or contract asked for.
  // BID-20 (petitions and conflicts of interest) is a workspace: the title of the page is compared, with no package asked for.
  'BID-20': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // QMS-04 (inspection requests) is a workspace: the title of the page is compared, with no contract asked for.
  'QMS-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // QMS-05 (quality acceptance minutes) is a workspace: the title of the page is compared, with no contract asked for.
  'QMS-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // AST-01 (the handovers) is a workspace and AST-02 (the minutes of a handover) carries the link back to the list above the title.
  'AST-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'AST-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // QMS-07 (the non-conformances) is a board: the title of the page is compared, with no contract asked for.
  'QMS-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CTR-08': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // CTR-10 (record the work done) is a detail screen under the site diary: the back link above the title and the title are compared, with no contract asked for.
  'CTR-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // CTR-12 (acceptance of work) is a workspace: the title of the page is compared, with no contract asked for.
  'CTR-12': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-01 (the list of payment requests) and CTR-13 (how the amount is made up) are workspaces: the title of the page is compared, with no request asked for.
  'PAY-01': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CTR-13': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-07 (advances and recovery) and CTR-06 (their schedule) are workspaces: the title of the page is compared, with no contract asked for.
  'PAY-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CTR-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-04 (the follow-up of what goes to the Treasury) is a workspace; PAY-14 (the forms of a request) carries the link back to it above the title once a request is chosen.
  'PAY-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PAY-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-05 (the matching and the differences) and PAY-09 (the projects with the Treasury) are workspaces; PAY-06 (one difference) carries the link back to PAY-05 above the title.
  'PAY-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'PAY-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'PAY-09': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-17 (the trace of a payment) is a workspace: the title stands alone at the top.
  'PAY-17': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-15 (the settlement of a project) is a workspace: the title stands alone at the top.
  'PAY-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // PAY-08 (reversing a payment) carries the link back to PAY-05 above the title.
  'PAY-08': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // PAY-02 (the form) and PAY-03 (the detail) carry the link back to the list above the title.
  'PAY-02': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'PAY-03': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // PAY-10 (the cumulative ledger) is a workspace: the title of the page is compared, with no contract asked for.
  'PAY-10': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CTR-26': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'CTR-19': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CTR-20': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CTR-22 (suspend, resume and terminate): the mockup shows sample fields; the application opens without a contract (the address names none) and says so, with the title of the
  // mockup, so the frame and the title are compared.
  'CTR-22': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // CTR-04 (BOQ and payment milestones) and CTR-05 (guarantees and insurance): the mockups keep the generic subtitle of the prototype and sample rows; the application
  // opens without a contract (the address names none) and says so, with the title of the mockup, so the frame and the title are compared.
  'CTR-04': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'CTR-05': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // DIS-14 (reporting period calendar): the mockup keeps the generic subtitle of the prototype, so only the title is compared with the frame.
  'DIS-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // DIS-22 (reasoned reopening of a locked period): the mockup has the back link to DIS-21 above the title; its subtitle is the generic one of the prototype.
  'DIS-22': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
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
  // SAS-06 (the plan catalogue): the mockup is the generic prototype page (a table of placeholder columns under the module subtitle), the application draws the
  // list of plan versions, the editor and the feature matrix and says in its subtitle what a published version is, so the frame and the title are compared.
  'SAS-06': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  // SAS-07 (the subscription) and SAS-08 (the change of plan): the mockups are the generic prototype page (a form or a comparison of placeholder fields under the module
  // subtitle); the application draws the live subscription, the form, the preview and the history and says in its subtitle what each screen is for, so the frame, the back link and the title are compared. Both start with the back link "← Thuê bao và kỳ thanh toán" above the title, and their region covers it.
  'SAS-07': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  'SAS-08': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: BACKLINK_TITLE_ONLY,
  },
  // SAS-11 (the usage of the month): the mockup is the generic prototype page (a table of placeholder columns under the module subtitle), the application draws the
  // counters against their limits, the seats and the latest events and says in its subtitle what it shows, so the frame and the title are compared.
  'SAS-11': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
  // SAS-14 (renew and change a license) and SAS-16 (license history): the mockup is the generic compare / timeline page of the prototype, whose subtitle is a placeholder; the application says what the
  // screen does, so only the frame and the title are compared.
  'SAS-14': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
  },
  'SAS-15': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: SAS_DETAIL_HEADING,
  },
  'SAS-16': {
    sidebar: SIDEBAR,
    topbar: TOPBAR,
    heading: TITLE_ONLY,
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
const CONTROL_SCREENS: readonly string[] = ['SAS-01', 'SAS-02', 'SAS-03', 'SAS-04', 'SAS-06', 'SAS-07', 'SAS-08', 'SAS-11', 'SAS-12', 'SAS-13', 'SAS-14', 'SAS-15', 'SAS-16', 'SAS-22', 'SAS-25'];
/** SAS-03 shows the tenant its address names: the fixture tenant of the API stack. */
const queryOf = (id: string): string => {
  if (id === 'DOC-05') return `?devUser=owner&doc=${stackInfo().documents.visualSubmitted}`;
  if (id === 'DOC-06') return `?devUser=owner&doc=${stackInfo().documents.visualSigned}`;
  if (!CONTROL_SCREENS.includes(id)) return '?devUser=owner';
  return id === 'SAS-03' || id === 'SAS-04' || id === 'SAS-22' ? `?devUser=sysAdmin&tenant=${stackInfo().tenants.A}` : '?devUser=sysAdmin';
};

for (const id of ['ADM-01', 'ADM-02', 'ADM-07', 'ADM-09', 'ADM-10', 'ADM-11', 'ADM-12', 'ADM-15','ADM-03', 'ADM-05', 'ADM-17', 'BID-01', 'BID-02', 'BID-03', 'BID-04', 'BID-05', 'BID-15', 'BID-16', 'BID-17', 'BID-18', 'BID-19', 'BID-20', 'DGV-01', 'DGV-03', 'DGV-04', 'DGV-06', 'DGV-07', 'DOC-02', 'DOC-03', 'DOC-04', 'DOC-05', 'DOC-06', 'DOC-07', 'DOC-08', 'DOC-09', 'DOC-10', 'DOC-14', 'DOC-19', 'DOC-21', 'IAM-04', 'IAM-08', 'IAM-09', 'LND-01', 'LND-02', 'LND-10', 'LND-11', 'ISS-01', 'ISS-02', 'ISS-03', 'ISS-04', 'ISS-07', 'ISS-09', 'ISS-10', 'MDM-01', 'MDM-02', 'MDM-03', 'MDM-04', 'MDM-05', 'MDM-06', 'MDM-07', 'MDM-08', 'MDM-09', 'MDM-10', 'MDM-11', 'MDM-12', 'MDM-13', 'MDM-14', 'MDM-15', 'MDM-16', 'MDM-17', 'MDM-18', 'MDM-19', 'MDM-20', 'MDM-21', 'MDM-22', 'MDM-23', 'MDM-24', 'MDM-25', 'MDM-26', 'MDM-29', 'MDM-27', 'MDM-28', 'MDM-31', 'MDM-32', 'MDM-33', 'MDM-34', 'MDM-37', 'MNE-01', 'MNE-02', 'NOT-01', 'NOT-02', 'NOT-03', 'NOT-11', 'NOT-12', 'NOT-13', 'NOT-17', 'PMT-01', 'PMT-02', 'PMT-03', 'PMT-04', 'PMT-05', 'PMT-06', 'PRJ-01', 'PRJ-02', 'PRJ-03', 'PRJ-09', 'PRJ-10', 'PRJ-14', 'PRJ-15', 'PRJ-17', 'PRJ-18', 'PRJ-21', 'PAY-13', 'CAP-01', 'CAP-02', 'CAP-03', 'CAP-04', 'CAP-05', 'CAP-06', 'CAP-07', 'CAP-08', 'CAP-10', 'CAP-11', 'CAP-14', 'CAP-15', 'CAP-16', 'CAP-17', 'CAP-20', 'CTR-03', 'CTR-04', 'CTR-05', 'CTR-07', 'CTR-08', 'CTR-10', 'CTR-19', 'CTR-20', 'CTR-22', 'CTR-26', 'DIS-14', 'DIS-22', 'SAS-01','SAS-02', 'SAS-03', 'SAS-04', 'SAS-06', 'SAS-07', 'SAS-08', 'SAS-11', 'SAS-12', 'SAS-13', 'SAS-14', 'SAS-15', 'SAS-16', 'SAS-22', 'SAS-25', 'QMS-04', 'QMS-05', 'QMS-07', 'AST-01', 'AST-02', 'CTR-12', 'PAY-10', 'PAY-01', 'PAY-02', 'PAY-03', 'CTR-13', 'PAY-07', 'CTR-06', 'PAY-04', 'PAY-14', 'PAY-05', 'PAY-06', 'PAY-09', 'PAY-08', 'PAY-15', 'PAY-17'] as const) {
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
