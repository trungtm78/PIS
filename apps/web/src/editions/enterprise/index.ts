import { ENTERPRISE_EDITION_MANIFEST } from '@machvon/edition-enterprise';
import type { EditionNavigationEntry, WebEditionBundle } from '../edition';
import helpVi from './help.overlay.vi.json';
import en from './overlay.en.json';
import vi from './overlay.vi.json';
import { enterpriseScreens } from './screen-loaders';
import FundingStructureScreen from './screens/leader/FundingStructureScreen';
import { useSnapshotDisbursed } from './screens/leader/hooks';
import { LeaderPanel } from './screens/leader/LeaderPanel';

/**
 * The sidebar entries only the enterprise edition has, after "Giải ngân" (DIS): the reporting chain (reports to the group, push to HPM and the reconciliation with Oracle EBS) and then the directions and meetings. The
 * EBS screens sit under the HPM entry (`covers`) so that they keep it active. Labels are keys of the base catalogue (`parts/navext.*.json`).
 */
export const ENTERPRISE_NAVIGATION: readonly EditionNavigationEntry[] = [
  {
    module: 'RPT',
    labelKey: 'shell.nav.entRpt.label',
    icon: 'contract',
    after: 'DIS',
    shortcuts: [
      ['RPT-01', 'shell.nav.entRpt.catalogue.label'],
      ['RPT-02', 'shell.nav.entRpt.drafts.label'],
      ['RPT-03', 'shell.nav.entRpt.released.label'],
      ['RPT-09', 'shell.nav.entRpt.compare.label'],
    ],
  },
  {
    module: 'HPM',
    labelKey: 'shell.nav.entHpm.label',
    icon: 'data',
    after: 'DIS',
    covers: ['EBS'],
    shortcuts: [
      ['HPM-01', 'shell.nav.entHpm.push.label'],
      ['HPM-02', 'shell.nav.entHpm.correct.label'],
      ['EBS-01', 'shell.nav.entEbs.connection.label'],
      ['EBS-02', 'shell.nav.entEbs.reconcile.label'],
    ],
  },
  {
    module: 'DIR',
    labelKey: 'shell.nav.entDir.label',
    icon: 'engagement',
    after: 'DIS',
    shortcuts: [
      ['DIR-01', 'shell.nav.entDir.meetings.label'],
      ['DIR-03', 'shell.nav.entDir.tracking.label'],
      ['DIR-05', 'shell.nav.entDir.period.label'],
    ],
  },
];

/**
 * The web side of the enterprise edition: its manifest (from the package) and its terminology overlay and its screens (the connections to HPM and Oracle EBS, ENT-2). The overlay holds exactly the keys the
 * manifest lists for the web and only keys that exist in the base catalogue (`overlay.enterprise.test.ts` holds it to both).
 */
export const enterpriseBundle: WebEditionBundle = { manifest: ENTERPRISE_EDITION_MANIFEST, overlay: { vi, en }, screens: enterpriseScreens, slots: { leaderPanel: LeaderPanel, fundingStructure: FundingStructureScreen, homeFigures: { groupDigits: true, publicPlanBlocks: false, treasuryBlocks: false, useDisbursed: useSnapshotDisbursed } }, help: { vi: helpVi }, navigation: ENTERPRISE_NAVIGATION };
