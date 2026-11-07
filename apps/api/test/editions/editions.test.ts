import 'reflect-metadata';
import { Controller, Injectable } from '@nestjs/common';
import type { TenantDatabase } from '@machvon/db';
import { ALLOW_ALL, EditionError, PUBLIC_EDITION_MANIFEST, defineEditionManifest, moduleInEdition, resolveEdition } from '@machvon/kernel';
import type { EditionManifest } from '@machvon/kernel';
import { AppModule } from '../../src/app.module';
import type { AppModuleOptions } from '../../src/app.module';
import { loadEditionManifest } from '../../src/editions/load-edition';
import { defineModule } from '../../src/modules/module-descriptor';
import { MODULES, controllersOf, providersOf } from '../../src/modules/registry';

const OPTIONS = { database: {} as TenantDatabase, registry: new Map() } as AppModuleOptions;

@Controller('edition-both')
class BothController {}
@Controller('edition-enterprise-only')
class EnterpriseOnlyController {}
@Controller('edition-public-only')
class PublicOnlyController {}
@Controller('edition-switched-off')
class SwitchedOffController {}
@Injectable()
class EnterpriseOnlyProvider {}

const FIXTURE = [
  defineModule({ code: 'AAA', controllers: [BothController] }),
  defineModule({ code: 'BBB', controllers: [EnterpriseOnlyController], providers: [EnterpriseOnlyProvider], editions: ['enterprise'] }),
  defineModule({ code: 'CCC', controllers: [PublicOnlyController], editions: ['public'] }),
  defineModule({ code: 'DDD', controllers: [SwitchedOffController] }),
];

const enterprise = (patch: Partial<EditionManifest> = {}): EditionManifest =>
  defineEditionManifest({
    edition: 'enterprise',
    productName: { vi: 'Sản phẩm thử', en: 'Test product' },
    brand: { mark: { vi: 'XD', en: 'CI' }, themeColor: '#0F3B57' },
    modules: ALLOW_ALL,
    screens: ALLOW_ALL,
    menu: ALLOW_ALL,
    terminology: { web: [], mobile: [] },
    rulePacks: ['enterprise-investment'],
    ...patch,
  });

const names = (options: AppModuleOptions): string[] => controllersOf(options, FIXTURE).map((controller) => controller.name);

describe('the module registry by edition', () => {
  it('mounts exactly what it mounted before for the public edition, with a manifest or without one', () => {
    const before = controllersOf(OPTIONS);
    expect(controllersOf({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST })).toEqual(before);
    expect(providersOf({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST })).toEqual(providersOf(OPTIONS));
    expect(before.length).toBeGreaterThan(50);
  });

  it('has no registered module that belongs to the enterprise edition only (the public registry mounts no enterprise controller)', () => {
    const enterpriseOnly = MODULES.filter((module) => module.editions !== undefined && !module.editions.includes('public'));
    expect(enterpriseOnly.map((module) => module.code)).toEqual([]);
    const mounted = new Set(controllersOf({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST }));
    for (const module of MODULES) for (const controller of module.controllers) expect(mounted.has(controller)).toBe(true);
  });

  it('mounts a module of one edition only in that edition, controllers and providers alike', () => {
    expect(names({ ...OPTIONS })).toEqual(['BothController', 'PublicOnlyController', 'SwitchedOffController']);
    expect(names({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST })).toEqual(['BothController', 'PublicOnlyController', 'SwitchedOffController']);
    expect(names({ ...OPTIONS, edition: enterprise() })).toEqual(['BothController', 'EnterpriseOnlyController', 'SwitchedOffController']);
    expect(providersOf({ ...OPTIONS, edition: enterprise() }, FIXTURE)).toEqual([EnterpriseOnlyProvider]);
    expect(providersOf({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST }, FIXTURE)).toEqual([]);
  });

  it('drops the modules the manifest does not list, or denies, by their code', () => {
    expect(names({ ...OPTIONS, edition: enterprise({ modules: { allow: ['AAA', 'BBB'], deny: [] } }) })).toEqual(['BothController', 'EnterpriseOnlyController']);
    expect(names({ ...OPTIONS, edition: enterprise({ modules: { allow: '*', deny: ['DDD', 'AAA'] } }) })).toEqual(['EnterpriseOnlyController']);
    expect(providersOf({ ...OPTIONS, edition: enterprise({ modules: { allow: ['AAA'], deny: [] } }) }, FIXTURE)).toEqual([]);
  });

  it('still lets a module decide for itself with enabled(options) on top of the edition', () => {
    const gated = [defineModule({ code: 'EEE', controllers: [BothController], enabled: (options) => options.edition?.edition === 'enterprise' })];
    expect(controllersOf({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST }, gated)).toEqual([]);
    expect(controllersOf({ ...OPTIONS, edition: enterprise() }, gated)).toEqual([BothController]);
    // enabled says yes and the edition says no: no.
    const both = [defineModule({ code: 'FFF', controllers: [BothController], enabled: () => true, editions: ['enterprise'] })];
    expect(controllersOf({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST }, both)).toEqual([]);
  });

  it('composes the AppModule from the edition it is given', () => {
    const composed = (options: AppModuleOptions): unknown[] => AppModule.register(options).controllers ?? [];
    const whole = composed({ ...OPTIONS, edition: PUBLIC_EDITION_MANIFEST });
    expect(whole).toEqual(composed(OPTIONS));
    const narrowed = composed({ ...OPTIONS, edition: enterprise({ modules: { allow: '*', deny: ['CAP'] } }) });
    const cap = MODULES.find((module) => module.code === 'CAP');
    expect(cap).toBeDefined();
    for (const controller of cap?.controllers ?? []) {
      expect(whole).toContain(controller);
      expect(narrowed).not.toContain(controller);
    }
    expect(narrowed.length).toBeLessThan(whole.length);
  });
});

describe('loadEditionManifest', () => {
  it('gives the public manifest without touching the enterprise loader', async () => {
    const loader = jest.fn(() => Promise.reject(new Error('must not be called')));
    await expect(loadEditionManifest('public', loader)).resolves.toBe(PUBLIC_EDITION_MANIFEST);
    expect(loader).not.toHaveBeenCalled();
  });

  it('gives the manifest the enterprise loader hands over', async () => {
    const manifest = enterprise();
    await expect(loadEditionManifest('enterprise', () => Promise.resolve(manifest))).resolves.toBe(manifest);
  });

  it('fails when the enterprise loader hands over a public manifest, and when it fails', async () => {
    await expect(loadEditionManifest('enterprise', () => Promise.resolve(PUBLIC_EDITION_MANIFEST))).rejects.toBeInstanceOf(EditionError);
    await expect(loadEditionManifest('enterprise', () => Promise.reject(new Error('package missing')))).rejects.toThrow('package missing');
  });

  it('loads the real enterprise package by default, and it is the enterprise edition', async () => {
    const manifest = await loadEditionManifest('enterprise');
    expect(manifest.edition).toBe('enterprise');
    expect(manifest.productName.vi).toBe('Phần mềm quản lý đầu tư xây dựng');
    // The enterprise edition starts with every module (ENT-0): the registry mounts what the public one mounts.
    expect(controllersOf({ ...OPTIONS, edition: manifest })).toEqual(controllersOf(OPTIONS));
  });
});

describe('the edition of the environment (the matrix of the CI sets MACHVON_EDITION)', () => {
  it('mounts exactly the modules its manifest lists, and for the public edition every module', async () => {
    const edition = resolveEdition(process.env);
    const manifest = await loadEditionManifest(edition);
    expect(manifest.edition).toBe(edition);
    const expected = MODULES.filter((module) => moduleInEdition(manifest, module.code)).flatMap((module) => module.controllers);
    expect(controllersOf({ ...OPTIONS, edition: manifest })).toEqual(expected);
    if (edition === 'public') expect(expected).toEqual(MODULES.flatMap((module) => module.controllers));
    // Whatever the edition, a registered module of the enterprise edition only never reaches a public process.
    for (const module of MODULES) expect(module.editions === undefined || module.editions.includes('public')).toBe(true);
  });
});
