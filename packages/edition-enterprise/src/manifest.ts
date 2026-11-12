import { ALLOW_ALL, defineEditionManifest } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { LAUNCHER_NAME_VI, LOGO_ALT_VI, PRODUCT_NAME_VI, SHORT_NAME_VI, TAGLINE_VI } from './messages/manifest-texts.ts';

/**
 * The manifest of the enterprise edition: "Construction Investment Management Software", the product of a state enterprise (its Vietnamese name is in `messages/manifest-texts.ts`).
 *
 * ENT-0 gives the mechanism, so the enterprise edition starts from the whole module set and the whole menu; a lane that decides
 * a module does not belong to an enterprise (ENT-1, ENT-2) adds it to `deny` here, and the API mounting, the web routes and the
 * menu follow without another edit. The terminology keys are the words the enterprise says differently: the web overlay lives in
 * `apps/web/src/editions/enterprise/overlay.{vi,en}.json` and the phone overlay in `apps/mobile/lib/editions/enterprise/`;
 * a test holds both to these lists.
 */
export const ENTERPRISE_EDITION_MANIFEST: EditionManifest = defineEditionManifest({
  edition: 'enterprise',
  productName: { vi: PRODUCT_NAME_VI, en: 'Construction Investment Management Software' },
  brand: {
    mark: { vi: 'XD', en: 'CI' },
    shortName: { vi: SHORT_NAME_VI, en: 'Constr. Inv.' },
    launcherName: { vi: LAUNCHER_NAME_VI, en: LAUNCHER_NAME_VI },
    logoAlt: { vi: LOGO_ALT_VI, en: 'Mạch Vốn logo, Construction Investment Management Software' },
    tagline: { vi: TAGLINE_VI, en: 'Capital to the right site, work on schedule' },
    themeColor: '#0F3B57',
  },
  modules: ALLOW_ALL,
  screens: ALLOW_ALL,
  menu: ALLOW_ALL,
  terminology: {
    web: [
      'cap.annual.page.subtitle',
      'cap.annual.total.note',
      'cap.fund.nsdpDtpt.label',
      'govc.home.kpi.plan.sub',
      'home.context.cutoff.label',
      'home.ov.hero.caption',
      'home.ov.hero.chip.pm',
      'home.ov.hero.chip.total',
      'home.ov.hero.noData',
      'home.ov.hero.ring',
      'home.ov.kpi.plan.subMissing',
      'home.ov.rank.caption',
      'home.profile.evidence.disbursed',
      'home.profile.evidence.planPm',
      'home.profile.evidence.ratePm',
      'home.tile.metric.disbursed',
      'home.tile.metric.planPm',
      'home.tile.nullReason.treasuryNone',
      'logo.mark.alt',
      'pay.payment.status.sentTreasury',
      'prj.create.nationalCode.label',
      'prj.guard.nationalCode.label',
      'prj.list.column.nationalCode',
      'prj.list.missingCode.label',
      'prj.nationalCode.missing.badge',
      'prj.reconcile.assign.aria',
      'prj.reconcile.column.nationalCode',
      'prj.reconcile.dialog.code.label',
      'prj.reconcile.dialog.current.none',
      'prj.reconcile.dialog.current.text',
      'prj.reconcile.dialog.title',
      'prj.reconcile.field.codeRequired.error',
      'prj.reconcile.import.title',
      'prj.reconcile.importRow.duplicate.text',
      'prj.reconcile.missing.count',
      'prj.reconcile.missingOnly.label',
      'prj.reconcile.page.title',
      'prj.stageProblem.nationalCodeFormat.error',
      'prj.stageProblem.nationalCodeRequired.error',
      'shell.app.name.title',
      'shell.brand.home.label',
      'shell.brand.mark.text',
      'shell.brand.name.text',
    ],
    mobile: [
      'mob.account.biometric.reason',
      'mob.alert.source.treasuryRecon.label',
      'mob.home.context.cutoff.label',
      'mob.home.leader.title',
      'mob.home.tile.metric.disbursed',
      'mob.home.tile.metric.planPm',
      'mob.home.tile.metric.ratePm',
      'mob.home.tile.nullReason.treasuryNone',
      'mob.prj.list.work.treasury',
      'mob.release.upgrade.failed',
      'mob.signIn.logo.label',
      'mob.signIn.unlock.reason',
      'mob.welcome.logo.label',
      'mob.welcome.title.text',
    ],
  },
  rulePacks: ['enterprise-investment'],
});
