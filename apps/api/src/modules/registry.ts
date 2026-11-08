import { PUBLIC_EDITION_MANIFEST, moduleInEdition } from '@machvon/kernel';
import type { Provider, Type } from '@nestjs/common';
import type { AppModuleOptions } from '../app.module';
import type { ModuleDescriptor } from './module-descriptor';
import { admModule } from './adm';
import { astModule } from './ast';
import { audModule } from './aud';
import { banModule } from './committee';
import { biModule } from './bi';
import { bidModule } from './bid';
import { capModule } from './cap';
import { ctrModule } from './ctr';
import { dgvModule } from './dgv';
import { dirModule } from './dir';
import { indModule } from './ind';
import { disModule } from './dis';
import { docModule } from './doc';
import { fndModule } from './fnd';
import { iamModule } from './iam';
import { intModule } from './int';
import { issModule } from './iss';
import { llmModule } from './llm';
import { lndModule } from './lnd';
import { mdmModule } from './mdm';
import { mneModule } from './mne';
import { mobModule } from './mob';
import { filesModule } from './files';
import { homeModule } from './home';
import { hubModule } from './hub';
import { notificationsModule } from './notifications';
import { omniModule } from './omni';
import { orchestrationModule } from './orchestration';
import { payModule } from './pay';
import { pmtModule } from './pmt';
import { prjModule } from './prj';
import { qmsModule } from './qms';
import { rptModule } from './reports';
import { sasModule } from './sas';
import { searchModule } from './search';

/** Every business module of the API, sorted by code. A slice adds one line here (one import and one entry). */
export const MODULES: readonly ModuleDescriptor[] = [admModule, astModule, audModule, banModule, bidModule, biModule, capModule, ctrModule, dgvModule, dirModule, disModule, docModule, filesModule, fndModule, homeModule, hubModule, iamModule, indModule, intModule, issModule, llmModule, lndModule, mdmModule, mneModule, mobModule, notificationsModule, omniModule, orchestrationModule, payModule, pmtModule, prjModule, qmsModule, rptModule, sasModule, searchModule];

function activeModules(options: AppModuleOptions, registered: readonly ModuleDescriptor[]): ModuleDescriptor[] {
  // The modules of the edition (a package of its own, loaded by the process) come after the registry, so the order of the registry is what it was.
  const modules = options.editionModules === undefined ? registered : [...registered, ...options.editionModules];
  const codes = new Set<string>();
  for (const module of modules) {
    if (codes.has(module.code)) throw new Error(`module ${module.code} is registered twice`);
    codes.add(module.code);
  }
  return modules.filter((module) => (module.enabled?.(options) ?? true) && existsInEdition(module, options));
}

/** Whether the module exists in the edition of the options (the public one when they name none): its own list of editions and the manifest's module list both say yes. */
function existsInEdition(module: ModuleDescriptor, options: AppModuleOptions): boolean {
  const manifest = options.edition ?? PUBLIC_EDITION_MANIFEST;
  if (module.editions !== undefined && !module.editions.includes(manifest.edition)) return false;
  return moduleInEdition(manifest, module.code);
}

/** The codes of the modules that are mounted for these options (the boot guard of the approval engine judges the business types of these). */
export function activeModuleCodes(options: AppModuleOptions, modules: readonly ModuleDescriptor[] = MODULES): string[] {
  return activeModules(options, modules).map((module) => module.code);
}

/** The controllers of the active modules, in registry order; the control-plane part of a module only with the control plane. */
export function controllersOf(options: AppModuleOptions, modules: readonly ModuleDescriptor[] = MODULES): Type[] {
  return activeModules(options, modules).flatMap((module) => [...module.controllers, ...(options.control === undefined ? [] : (module.controlPlane?.controllers ?? []))]);
}

/** The providers of the active modules, in registry order; the control-plane part of a module only with the control plane. */
export function providersOf(options: AppModuleOptions, modules: readonly ModuleDescriptor[] = MODULES): Provider[] {
  return activeModules(options, modules).flatMap((module) => [...(module.providers ?? []), ...(options.control === undefined ? [] : (module.controlPlane?.providers ?? []))]);
}
