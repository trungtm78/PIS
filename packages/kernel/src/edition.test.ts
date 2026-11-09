import {
  ALLOW_ALL,
  DEFAULT_EDITION,
  EDITIONS,
  ENTERPRISE_ONLY_MODULES,
  EditionError,
  PUBLIC_EDITION_MANIFEST,
  allows,
  defineEditionManifest,
  filterAllowed,
  isEdition,
  moduleInEdition,
  moduleInMenu,
  overlayProblems,
  productNameOf,
  resolveEdition,
  resolveManifest,
  screenInEdition,
} from './edition.ts';
import type { EditionManifest } from './edition.ts';

const ENTERPRISE_FIXTURE: EditionManifest = defineEditionManifest({
  edition: 'enterprise',
  productName: { vi: 'Sản phẩm thử', en: 'Test product' },
  brand: { mark: { vi: 'XD', en: 'XD' }, themeColor: '#0A3D62' },
  modules: { allow: ['ADM', 'CAP', 'PRJ'], deny: ['PRJ'] },
  screens: { allow: '*', deny: ['CAP-02'] },
  menu: { allow: ['ADM'], deny: [] },
  terminology: { web: ['shell.brand.name.text'], mobile: ['mob.shell.tab.home'] },
  rulePacks: ['enterprise-investment'],
});

const refusal = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('resolveEdition', () => {
  it('is public when nothing is set, and for a blank value', () => {
    expect(DEFAULT_EDITION).toBe('public');
    expect(resolveEdition({})).toBe('public');
    expect(resolveEdition({ MACHVON_EDITION: '' })).toBe('public');
    expect(resolveEdition({ MACHVON_EDITION: '   ' })).toBe('public');
    expect(resolveEdition({ VITE_EDITION: undefined }, 'VITE_EDITION')).toBe('public');
  });

  it('reads the variable of the part that asks, and trims it', () => {
    expect(resolveEdition({ MACHVON_EDITION: 'enterprise' })).toBe('enterprise');
    expect(resolveEdition({ MACHVON_EDITION: ' enterprise \n' })).toBe('enterprise');
    expect(resolveEdition({ VITE_EDITION: 'enterprise' }, 'VITE_EDITION')).toBe('enterprise');
    // The API variable does not answer for the web build.
    expect(resolveEdition({ MACHVON_EDITION: 'enterprise' }, 'VITE_EDITION')).toBe('public');
    expect(resolveEdition({ MACHVON_EDITION: 'public', VITE_EDITION: 'enterprise' })).toBe('public');
  });

  it('fails loudly on a value that is not an edition, naming the variable and never the value', () => {
    for (const bad of ['Enterprise', 'PUBLIC', 'ent', 'both', 'true', '1', 'public,enterprise']) {
      const error = refusal(() => resolveEdition({ MACHVON_EDITION: bad }));
      expect(error).toBeInstanceOf(EditionError);
      expect((error as EditionError).message).toBe('MACHVON_EDITION must be one of public, enterprise; got an unknown value');
    }
    expect((refusal(() => resolveEdition({ VITE_EDITION: 'x' }, 'VITE_EDITION')) as EditionError).message).toContain('VITE_EDITION');
  });

  it('knows exactly two editions', () => {
    expect([...EDITIONS]).toEqual(['public', 'enterprise']);
    expect(isEdition('public')).toBe(true);
    expect(isEdition('enterprise')).toBe(true);
    expect(isEdition('Public')).toBe(false);
    expect(isEdition(undefined)).toBe(false);
  });
});

describe('allow lists', () => {
  it('lets everything through for "*", less the denied ids', () => {
    expect(allows(ALLOW_ALL, 'ANY')).toBe(true);
    expect(allows({ allow: '*', deny: ['CAP'] }, 'CAP')).toBe(false);
    expect(allows({ allow: '*', deny: ['CAP'] }, 'PAY')).toBe(true);
  });

  it('lets only the listed ids through, and the deny list wins', () => {
    const list = { allow: ['ADM', 'CAP'], deny: ['CAP'] };
    expect(allows(list, 'ADM')).toBe(true);
    expect(allows(list, 'CAP')).toBe(false);
    expect(allows(list, 'PAY')).toBe(false);
    expect(allows({ allow: [], deny: [] }, 'ADM')).toBe(false);
  });

  it('filters items by id and keeps their order', () => {
    const items = [{ id: 'C' }, { id: 'A' }, { id: 'B' }];
    expect(filterAllowed({ allow: ['A', 'B'], deny: [] }, items, (item) => item.id).map((item) => item.id)).toEqual(['A', 'B']);
    expect(filterAllowed(ALLOW_ALL, items, (item) => item.id)).toEqual(items);
  });
});

describe('the public manifest', () => {
  it('keeps the product as it is: the name, everything on, no overlay', () => {
    expect(PUBLIC_EDITION_MANIFEST.edition).toBe('public');
    expect(PUBLIC_EDITION_MANIFEST.productName).toEqual({ vi: 'Hệ thống quản lý đầu tư công', en: 'Public Investment Management System' });
    expect(PUBLIC_EDITION_MANIFEST.brand.mark).toEqual({ vi: 'ĐT', en: 'PI' });
    expect(PUBLIC_EDITION_MANIFEST.modules).toEqual({ allow: '*', deny: ['EBS', 'HPM', 'ORG', 'LDR', 'RML'] });
    expect(ENTERPRISE_ONLY_MODULES).toEqual(['EBS', 'HPM', 'ORG', 'LDR', 'RML']);
    expect(PUBLIC_EDITION_MANIFEST.modules).toEqual({ allow: '*', deny: ['EBS', 'EQP', 'HPM'] });
    expect(ENTERPRISE_ONLY_MODULES).toEqual(['EBS', 'EQP', 'HPM']);
    expect(PUBLIC_EDITION_MANIFEST.screens).toEqual(ALLOW_ALL);
    expect(PUBLIC_EDITION_MANIFEST.menu).toEqual(ALLOW_ALL);
    expect(PUBLIC_EDITION_MANIFEST.terminology).toEqual({ web: [], mobile: [] });
    expect(Object.isFrozen(PUBLIC_EDITION_MANIFEST)).toBe(true);
  });

  it('knows nothing of the enterprise edition (its manifest lives in its own package)', () => {
    expect(JSON.stringify(PUBLIC_EDITION_MANIFEST)).not.toMatch(/xây dựng|enterprise/i);
  });

  it('mounts every module and screen and lists every module in the menu', () => {
    expect(moduleInEdition(PUBLIC_EDITION_MANIFEST, 'CAP')).toBe(true);
    expect(screenInEdition(PUBLIC_EDITION_MANIFEST, { id: 'CAP-01', module: 'CAP' })).toBe(true);
    expect(moduleInMenu(PUBLIC_EDITION_MANIFEST, 'CAP')).toBe(true);
  });
});

describe('resolveManifest', () => {
  it('gives the public manifest for public, with or without an enterprise one at hand', () => {
    expect(resolveManifest('public')).toBe(PUBLIC_EDITION_MANIFEST);
    expect(resolveManifest('public', ENTERPRISE_FIXTURE)).toBe(PUBLIC_EDITION_MANIFEST);
  });

  it('gives the enterprise manifest that was handed in, and refuses to start without one', () => {
    expect(resolveManifest('enterprise', ENTERPRISE_FIXTURE)).toBe(ENTERPRISE_FIXTURE);
    expect(refusal(() => resolveManifest('enterprise'))).toBeInstanceOf(EditionError);
  });

  it('refuses a public manifest handed in as the enterprise one', () => {
    expect(refusal(() => resolveManifest('enterprise', PUBLIC_EDITION_MANIFEST))).toBeInstanceOf(EditionError);
  });
});

describe('what an edition lets through', () => {
  it('judges a module by the module list, a screen by its module and the screen list, the menu by the module list too', () => {
    expect(moduleInEdition(ENTERPRISE_FIXTURE, 'ADM')).toBe(true);
    expect(moduleInEdition(ENTERPRISE_FIXTURE, 'PRJ')).toBe(false);
    expect(moduleInEdition(ENTERPRISE_FIXTURE, 'PAY')).toBe(false);
    expect(screenInEdition(ENTERPRISE_FIXTURE, { id: 'CAP-01', module: 'CAP' })).toBe(true);
    expect(screenInEdition(ENTERPRISE_FIXTURE, { id: 'CAP-02', module: 'CAP' })).toBe(false);
    expect(screenInEdition(ENTERPRISE_FIXTURE, { id: 'PAY-01', module: 'PAY' })).toBe(false);
    // CAP exists but is not in the menu: reachable by a link, not offered.
    expect(moduleInMenu(ENTERPRISE_FIXTURE, 'ADM')).toBe(true);
    expect(moduleInMenu(ENTERPRISE_FIXTURE, 'CAP')).toBe(false);
    // A module that does not exist is not in the menu even when the menu lists it.
    expect(moduleInMenu({ ...ENTERPRISE_FIXTURE, menu: ALLOW_ALL }, 'PAY')).toBe(false);
  });

  it('names the product in the language asked, Vietnamese for any other', () => {
    expect(productNameOf(ENTERPRISE_FIXTURE, 'en')).toBe('Test product');
    expect(productNameOf(ENTERPRISE_FIXTURE, 'vi')).toBe('Sản phẩm thử');
    expect(productNameOf(ENTERPRISE_FIXTURE, 'fr')).toBe('Sản phẩm thử');
  });
});

describe('defineEditionManifest', () => {
  const valid = ENTERPRISE_FIXTURE;
  const broken = (patch: Partial<EditionManifest>): unknown => refusal(() => defineEditionManifest({ ...valid, ...patch }));

  it('freezes what it returns', () => {
    expect(Object.isFrozen(valid)).toBe(true);
  });

  it('refuses an unknown edition and an empty name or mark', () => {
    expect(broken({ edition: 'other' as never })).toBeInstanceOf(EditionError);
    expect(broken({ productName: { vi: ' ', en: 'x' } })).toBeInstanceOf(EditionError);
    expect(broken({ productName: { vi: 'x', en: '' } })).toBeInstanceOf(EditionError);
    expect(broken({ brand: { mark: { vi: '', en: 'X' }, themeColor: '#102E3B' } })).toBeInstanceOf(EditionError);
  });

  it('refuses a theme colour that is not a 6-digit hex', () => {
    for (const colour of ['red', '#fff', '102E3B', '#102E3B80']) expect(broken({ brand: { mark: valid.brand.mark, themeColor: colour } })).toBeInstanceOf(EditionError);
  });

  it('refuses malformed or repeated module codes, screen ids and menu codes', () => {
    expect(broken({ modules: { allow: ['adm'], deny: [] } })).toBeInstanceOf(EditionError);
    expect(broken({ modules: { allow: ['ADM', 'ADM'], deny: [] } })).toBeInstanceOf(EditionError);
    expect(broken({ modules: { allow: '*', deny: ['A', 'B'] } })).toBeInstanceOf(EditionError);
    expect(broken({ modules: { allow: '*', deny: ['ADM', 'ADM'] } })).toBeInstanceOf(EditionError);
    expect(broken({ screens: { allow: ['CAP1'], deny: [] } })).toBeInstanceOf(EditionError);
    expect(broken({ menu: { allow: ['ADM-01'], deny: [] } })).toBeInstanceOf(EditionError);
  });

  it('refuses malformed, repeated or mis-placed terminology keys', () => {
    expect(broken({ terminology: { web: ['Shell'], mobile: [] } })).toBeInstanceOf(EditionError);
    expect(broken({ terminology: { web: ['shell.a.b', 'shell.a.b'], mobile: [] } })).toBeInstanceOf(EditionError);
    expect(broken({ terminology: { web: [], mobile: ['mob.a.b', 'mob.a.b'] } })).toBeInstanceOf(EditionError);
    expect(broken({ terminology: { web: [], mobile: ['shell.brand.name'] } })).toBeInstanceOf(EditionError);
  });

  it('refuses malformed or repeated rule pack ids', () => {
    expect(broken({ rulePacks: ['Enterprise'] })).toBeInstanceOf(EditionError);
    expect(broken({ rulePacks: ['a-', 'b'] })).toBeInstanceOf(EditionError);
    expect(broken({ rulePacks: ['a', 'a'] })).toBeInstanceOf(EditionError);
  });
});

describe('overlayProblems', () => {
  const base = { 'shell.brand.name.text': 'A', 'shell.app.name.title': 'B', 'x.y.z.w': 'C' };

  it('is empty for an overlay that holds exactly the listed keys, all known to the base', () => {
    expect(overlayProblems(['shell.brand.name.text'], { 'shell.brand.name.text': 'N' }, base)).toEqual({ unlisted: [], missing: [], unknownToBase: [] });
  });

  it('reports the keys the manifest does not list, the listed keys the overlay lacks, and the keys the base does not know', () => {
    const problems = overlayProblems(['shell.brand.name.text', 'shell.app.name.title'], { 'shell.brand.name.text': 'N', 'new.key.here': 'Z', 'x.y.z.w': 'W' }, base);
    expect(problems.unlisted).toEqual(['new.key.here', 'x.y.z.w']);
    expect(problems.missing).toEqual(['shell.app.name.title']);
    expect(problems.unknownToBase).toEqual(['new.key.here']);
  });
});
