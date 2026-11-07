import { ALLOW_ALL, defineEditionManifest } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';

/**
 * The manifest of the enterprise edition: "Phần mềm quản lý đầu tư xây dựng", the product of a state enterprise.
 *
 * ENT-0 gives the mechanism, so the enterprise edition starts from the whole module set and the whole menu; a lane that decides
 * a module does not belong to an enterprise (ENT-1, ENT-2) adds it to `deny` here, and the API mounting, the web routes and the
 * menu follow without another edit. The terminology keys are the words the enterprise says differently: the web overlay lives in
 * `apps/web/src/editions/enterprise/overlay.{vi,en}.json` and the phone overlay in `apps/mobile/lib/editions/enterprise/`;
 * a test holds both to these lists.
 */
export const ENTERPRISE_EDITION_MANIFEST: EditionManifest = defineEditionManifest({
  edition: 'enterprise',
  productName: { vi: 'Phần mềm quản lý đầu tư xây dựng', en: 'Construction Investment Management Software' },
  brand: { mark: { vi: 'XD', en: 'CI' }, themeColor: '#0F3B57' },
  modules: ALLOW_ALL,
  screens: ALLOW_ALL,
  menu: ALLOW_ALL,
  terminology: {
    web: ['shell.app.name.title', 'shell.brand.home.label', 'shell.brand.mark.text', 'shell.brand.name.text'],
    mobile: ['mob.account.biometric.reason', 'mob.release.upgrade.failed', 'mob.signIn.unlock.reason', 'mob.welcome.logo.label', 'mob.welcome.title.text'],
  },
  rulePacks: ['enterprise-investment'],
});
