import { ENTERPRISE_EDITION_MANIFEST } from '@machvon/edition-enterprise';
import type { WebEditionBundle } from '../edition';
import en from './overlay.en.json';
import vi from './overlay.vi.json';
import { enterpriseScreens } from './screen-loaders';

/**
 * The web side of the enterprise edition: its manifest (from the package) and its terminology overlay and its screens (the connections to HPM and Oracle EBS, ENT-2). The overlay holds exactly the keys the
 * manifest lists for the web and only keys that exist in the base catalogue (`overlay.enterprise.test.ts` holds it to both).
 */
export const enterpriseBundle: WebEditionBundle = { manifest: ENTERPRISE_EDITION_MANIFEST, overlay: { vi, en }, screens: enterpriseScreens };
