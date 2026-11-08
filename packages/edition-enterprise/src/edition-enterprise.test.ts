import { PUBLIC_EDITION_MANIFEST, resolveManifest } from '@machvon/kernel/src/edition.ts';
import { ADAPTER_KINDS, ENTERPRISE_ADAPTERS, ENTERPRISE_EDITION, ENTERPRISE_EDITION_MANIFEST, defineAdapterRegistry } from './index.ts';

describe('the enterprise manifest', () => {
  it('is the enterprise edition under its own name', () => {
    expect(ENTERPRISE_EDITION_MANIFEST.edition).toBe('enterprise');
    expect(ENTERPRISE_EDITION_MANIFEST.productName).toEqual({ vi: 'Phần mềm quản lý đầu tư xây dựng', en: 'Construction Investment Management Software' });
    expect(ENTERPRISE_EDITION_MANIFEST.productName.vi).not.toBe(PUBLIC_EDITION_MANIFEST.productName.vi);
    expect(ENTERPRISE_EDITION_MANIFEST.brand.mark.vi).not.toBe(PUBLIC_EDITION_MANIFEST.brand.mark.vi);
    expect(ENTERPRISE_EDITION_MANIFEST.rulePacks).toEqual(['enterprise-investment']);
  });

  it('is what the kernel hands out for the enterprise edition', () => {
    expect(resolveManifest('enterprise', ENTERPRISE_EDITION.manifest)).toBe(ENTERPRISE_EDITION_MANIFEST);
  });

  it('lists the words it says differently, on the web and on the phone, without repeating one', () => {
    const { web, mobile } = ENTERPRISE_EDITION_MANIFEST.terminology;
    expect(web.length).toBeGreaterThan(0);
    expect(mobile.length).toBeGreaterThan(0);
    expect(mobile.every((key) => key.startsWith('mob.'))).toBe(true);
    expect(web).toEqual([...web].sort());
    expect(mobile).toEqual([...mobile].sort());
  });
});

describe('the adapter registry', () => {
  it('holds the two connections of ENT-2: the file writer that stands for HPM and the file reader of Oracle EBS', () => {
    expect(ENTERPRISE_ADAPTERS.all).toEqual([
      { id: 'hpm.reports', kind: 'hpm' },
      { id: 'ebs.ledger', kind: 'ebs' },
    ]);
    expect(ENTERPRISE_ADAPTERS.has('ebs.ledger')).toBe(true);
    expect(ENTERPRISE_ADAPTERS.get('hpm.reports')).toEqual({ id: 'hpm.reports', kind: 'hpm' });
    expect(ENTERPRISE_ADAPTERS.get('lakehouse.read')).toBeUndefined();
    expect(ENTERPRISE_EDITION.adapters).toBe(ENTERPRISE_ADAPTERS);
  });

  it('knows the systems around the enterprise', () => {
    expect([...ADAPTER_KINDS]).toEqual(['hpm', 'ebs', 'lakehouse', 'open-api']);
  });

  it('finds an adapter by id and by kind, and freezes the list', () => {
    const registry = defineAdapterRegistry([
      { id: 'ebs.ledger', kind: 'ebs' },
      { id: 'hpm.monthly', kind: 'hpm' },
      { id: 'ebs.vendors', kind: 'ebs' },
    ]);
    expect(registry.has('hpm.monthly')).toBe(true);
    expect(registry.get('ebs.vendors')).toEqual({ id: 'ebs.vendors', kind: 'ebs' });
    expect(registry.ofKind('ebs').map((adapter) => adapter.id)).toEqual(['ebs.ledger', 'ebs.vendors']);
    expect(registry.ofKind('lakehouse')).toEqual([]);
    expect(Object.isFrozen(registry.all)).toBe(true);
  });

  it('refuses a malformed id, an unknown kind and a repeated id', () => {
    expect(() => defineAdapterRegistry([{ id: 'ebs.ledger', kind: 'sap' as never }])).toThrow('unknown kind');
    expect(() =>
      defineAdapterRegistry([
        { id: 'a.b', kind: 'hpm' },
        { id: 'a.b', kind: 'ebs' },
      ]),
    ).toThrow('twice');
  });
});
