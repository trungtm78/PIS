import type { Provider, Type } from '@nestjs/common';
import type { Edition } from '@machvon/kernel';
import type { AppModuleOptions } from '../app.module';

const MODULE_CODE = /^[A-Z]{2,6}$/;

/**
 * What a business module contributes to the application: its controllers and providers, and the condition under
 * which it is active. A slice adds its descriptor to `registry.ts`; `AppModule` composes the registry and is not
 * edited again for that slice.
 */
export interface ModuleDescriptor {
  /** The module code of the design (NOT, ADM, MDM...): two to six capital letters. */
  code: string;
  controllers: readonly Type[];
  providers?: readonly Provider[];
  /** Whether the module is active for these application options; default: always. */
  enabled?(options: AppModuleOptions): boolean;
  /**
   * The editions the module exists in (ENT-0); default: all of them. A module of one edition only lists it, so the other edition mounts none of its
   * controllers or providers. The manifest of the edition (`options.edition`) can switch a module off as well, by its code.
   */
  editions?: readonly Edition[];
  /**
   * What the module adds only where the application options carry the control plane (`options.control`). The controllers
   * and providers above stay active without it, so a read that needs no control database is never switched off by it.
   */
  controlPlane?: { controllers: readonly Type[]; providers?: readonly Provider[] };
}

/** Validates and returns a descriptor, so a malformed module fails when the registry is loaded. */
export function defineModule(descriptor: ModuleDescriptor): ModuleDescriptor {
  if (!MODULE_CODE.test(descriptor.code)) {
    throw new Error(`module code ${descriptor.code} must be two to six capital letters`);
  }
  if (descriptor.controllers.length === 0 && (descriptor.providers ?? []).length === 0) {
    throw new Error(`module ${descriptor.code} declares neither controllers or providers`);
  }
  return descriptor;
}
