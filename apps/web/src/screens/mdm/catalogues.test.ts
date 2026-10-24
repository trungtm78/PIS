import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { CATALOGUES, COLUMN_KEYS, camel, inTreeOrder, toCsv } from './catalogues';
import { amountText } from './RulePanel';
import { TYPE_FORMS, attributesOf, formKeys, keyPart, withAttribute, wordsOf } from './typeForms';
import { record } from './test-support';
import { toRecord } from './model';
import type { RecordView } from './model';

const entry = (n: number, key: string, parent: number | null = null): RecordView => {
  const view = toRecord(record(n, { business_key: key, parent_record_id: parent === null ? null : record(parent).id })) as RecordView;
  return view;
};

describe('the catalogue configuration', () => {
  it('has a title in both languages for each screen and a heading for each column', () => {
    for (const config of Object.values(CATALOGUES)) {
      for (const catalogue of [vi_, en] as Array<Record<string, string>>) {
        expect(catalogue[`mdm.${config.slug}.page.title`]).toBeTruthy();
      }
    }
    for (const key of COLUMN_KEYS) {
      for (const catalogue of [vi_, en] as Array<Record<string, string>>) expect(catalogue[`mdm.catalogue.${key}.column`]).toBeTruthy();
    }
    expect(Object.keys(CATALOGUES).sort()).toEqual([
      'MDM-04',
      'MDM-05',
      'MDM-06',
      'MDM-07',
      'MDM-08',
      'MDM-09',
      'MDM-10',
      'MDM-12',
      'MDM-13',
      'MDM-14',
      'MDM-15',
      'MDM-16',
      'MDM-17',
      'MDM-18',
      'MDM-19',
      'MDM-20',
      'MDM-21',
      'MDM-22',
      'MDM-23',
    ]);
  });

  it('has a label for each attribute of a form and a text for each value a list offers, in both languages', () => {
    const { labels, values } = formKeys();
    expect(labels.length).toBe(Object.values(TYPE_FORMS).reduce((count, specs) => count + specs.length, 0));
    for (const catalogue of [vi_, en] as Array<Record<string, string>>) {
      for (const [type, name] of labels) expect(catalogue[`mdm.attr.${keyPart(type)}.${keyPart(name)}.label`]).toBeTruthy();
      for (const [family, value] of values) expect(catalogue[`mdm.value.${family}.${camel(value)}`]).toBeTruthy();
    }
  });

  it('writes a value of a list the way it is named in a translation key', () => {
    expect(camel('SUBSET_OF')).toBe('subsetOf');
    expect(camel('NSTW')).toBe('nstw');
    expect(camel('NATIONAL_TARGET')).toBe('nationalTarget');
    expect(camel('fund_source_key')).toBe('fundSourceKey');
    expect(camel('Asia/Ho_Chi_Minh')).toBe('asiaHoChiMinh');
    expect(camel('HALF_EVEN')).toBe('halfEven');
  });
});

describe('the order of a tree', () => {
  it('puts each entry under its parent, siblings by key, and starts a branch for an entry whose parent is not listed', () => {
    const order = inTreeOrder([entry(1, 'B'), entry(2, 'B-2', 1), entry(3, 'A'), entry(4, 'B-1', 1), entry(5, 'B-1-1', 4), entry(6, 'LOST', 99)]);
    expect(order.map(({ record: item, depth }) => `${depth}:${item.businessKey}`)).toEqual(['0:A', '0:B', '1:B-1', '2:B-1-1', '1:B-2', '0:LOST']);
  });

  it('does not lose or repeat an entry that is its own parent or part of a ring', () => {
    const own = inTreeOrder([entry(1, 'SELF', 1)]);
    expect(own.map(({ record: item }) => item.businessKey)).toEqual(['SELF']);
    const ring = inTreeOrder([entry(1, 'ONE', 2), entry(2, 'TWO', 1), entry(3, 'FREE')]);
    expect(ring.map(({ record: item }) => item.businessKey).sort()).toEqual(['FREE', 'ONE', 'TWO']);
    expect(new Set(ring.map(({ record: item }) => item.id)).size).toBe(3);
  });
});

describe('the CSV export', () => {
  it('quotes what needs quotes and starts with the byte order mark', () => {
    const csv = toCsv(['Code', 'Name'], [['A', 'one, two'], ['B', 'say "hi"'], ['C', 'two\nlines']]);
    expect(csv.startsWith('﻿Code,Name\r\n')).toBe(true);
    expect(csv).toContain('A,"one, two"\r\n');
    expect(csv).toContain('B,"say ""hi"""\r\n');
    expect(csv).toContain('C,"two\nlines"\r\n');
  });

  it('writes a cell that starts like a formula as text', () => {
    const csv = toCsv(['x'], [['=1+1'], ['+SUM(A1)'], ['-2'], ['@cmd'], ['\tTAB'], ['fine=ok']]);
    expect(csv).toContain("\r\n'=1+1\r\n");
    expect(csv).toContain("\r\n'+SUM(A1)\r\n");
    expect(csv).toContain("\r\n'-2\r\n");
    expect(csv).toContain("\r\n'@cmd\r\n");
    expect(csv).toContain("\r\n'\tTAB\r\n");
    expect(csv).toContain('\r\nfine=ok\r\n');
  });
});

describe('the typed attribute helpers', () => {
  it('reads the JSON text as an object, an empty text as no attributes, and anything else as not readable', () => {
    expect(attributesOf('')).toEqual({});
    expect(attributesOf('  ')).toEqual({});
    expect(attributesOf('{"a":1}')).toEqual({ a: 1 });
    expect(attributesOf('[1]')).toBeUndefined();
    expect(attributesOf('null')).toBeUndefined();
    expect(attributesOf('{oops')).toBeUndefined();
  });

  it('sets one attribute in the text, keeps the others and drops an empty one', () => {
    expect(JSON.parse(withAttribute('', 'rank', 2))).toEqual({ rank: 2 });
    expect(JSON.parse(withAttribute('{"a":1}', 'b', true))).toEqual({ a: 1, b: true });
    expect(JSON.parse(withAttribute('{"a":1,"b":2}', 'a', 5))).toEqual({ a: 5, b: 2 });
    expect(JSON.parse(withAttribute('{"a":1,"b":2}', 'a', undefined))).toEqual({ b: 2 });
    expect(JSON.parse(withAttribute('{"a":1,"b":[1]}', 'b', []))).toEqual({ a: 1 });
    expect(withAttribute('{"a":1}', 'a', '')).toBe('');
    expect(JSON.parse(withAttribute('{oops', 'a', 1))).toEqual({ a: 1 });
    expect(JSON.parse(withAttribute('{"a":1}', 'flag', false))).toEqual({ a: 1, flag: false });
  });

  it('splits a comma-separated list into words', () => {
    expect(wordsOf('a, b ,, c,')).toEqual(['a', 'b', 'c']);
    expect(wordsOf('')).toEqual([]);
  });
});

describe('the amounts of a threshold table', () => {
  it('groups the digits of the whole part and leaves the cents as they are', () => {
    expect(amountText('120000000000', 'en')).toBe('120,000,000,000');
    expect(amountText('1234.50', 'en')).toBe('1,234.50');
    expect(amountText('0', 'en')).toBe('0');
    // The separator of the cents is the language's own: Vietnamese groups with dots and has a comma before the cents.
    expect(amountText('1234.50', 'vi')).toBe('1.234,50');
    expect(amountText('120000000000', 'vi')).toBe('120.000.000.000');
    expect(amountText('12345678901234567890', 'en')).toBe('12,345,678,901,234,567,890');
    expect(amountText('not an amount', 'en')).toBe('not an amount');
  });
});
