import type { Provider, Type } from '@nestjs/common';
import type { AppModuleOptions } from '../app.module';
import type { ModuleDescriptor } from './module-descriptor';
import { admModule } from './adm';
import { astModule } from './ast';
import { bidModule } from './bid';
import { capModule } from './cap';
import { ctrModule } from './ctr';
import { dgvModule } from './dgv';
import { disModule } from './dis';
import { docModule } from './doc';
import { iamModule } from './iam';
import { issModule } from './iss';
import { lndModule } from './lnd';
import { mdmModule } from './mdm';
import { mneModule } from './mne';
import { filesModule } from './files';
import { notificationsModule } from './notifications';
import { orchestrationModule } from './orchestration';
import { payModule } from './pay';
import { pmtModule } from './pmt';
import { prjModule } from './prj';
import { qmsModule } from './qms';
import { sasModule } from './sas';
import { searchModule } from './search';

/** Every business module of the API, sorted by code. A slice adds one line here (one import and one entry). */
export const MODULES: readonly ModuleDescriptor[] = [admModule, astModule, bidModule, capModule, ctrModule, dgvModule, disModule, docModule, filesModule, iamModule, issModule, lndModule, mdmModule, mneModule, notificationsModule, orchestrationModule, payModule, pmtModule, prjModule, qmsModule, sasModule, searchModule];

function activeModules(options: AppModuleOptions, modules: readonly ModuleDescriptor[]): ModuleDescriptor[] {
  const codes = new Set<string>();
  for (const module of modules) {
    if (codes.has(module.code)) throw new Error(`module ${module.code} is registered twice`);
    codes.add(module.code);
  }
  return modules.filter((module) => module.enabled?.(options) ?? true);
}

/** The controllers of the active modules, in registry order; the control-plane part of a module only with the control plane. */
export function controllersOf(options: AppModuleOptions, modules: readonly ModuleDescriptor[] = MODULES): Type[] {
  return activeModules(options, modules).flatMap((module) => [...module.controllers, ...(options.control === undefined ? [] : (module.controlPlane?.controllers ?? []))]);
}

/** The providers of the active modules, in registry order; the control-plane part of a module only with the control plane. */
export function providersOf(options: AppModuleOptions, modules: readonly ModuleDescriptor[] = MODULES): Provider[] {
  return activeModules(options, modules).flatMap((module) => [...(module.providers ?? []), ...(options.control === undefined ? [] : (module.controlPlane?.providers ?? []))]);
}
