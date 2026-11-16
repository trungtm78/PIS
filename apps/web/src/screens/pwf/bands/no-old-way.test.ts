import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = __dirname;
const WEB = resolve(HERE, '../../../..');

const own = readdirSync(HERE)
  .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

/** PWF-08 was simplified to one short table (principle 0 of the plan of 16/11/2026): no cards of three fields per exception, no unit box, no second sentence for the owner's example. */
describe('the default thresholds page has no old way left', () => {
  it('has no unit to choose, no fieldset of fields for an exception and no separate owner example', () => {
    const old = own.filter(({ text }) => /SelectUnit|field-unit|<fieldset|owner-example|LadderFields|pwf-tpl-sub" data-override/.test(text));
    expect(old.map((one) => one.name)).toEqual([]);
  });

  it('keeps no key of the catalogues for the words of the old layout', () => {
    const vi = JSON.parse(readFileSync(resolve(WEB, 'src/i18n/vi.json'), 'utf8')) as Record<string, string>;
    const old = Object.keys(vi).filter((key) => /^fix9\.pwf08\.(ladder|preview|source|unit)|^pwf\.bands\.(title|subtitle|source\.title|unit\.hint|overrides\.|override\.(legend|add|remove|phase\.hint)|(green|yellow|red)\.label|preview\.owner|problem\.unitMismatch)/.test(key));
    expect(old).toEqual([]);
  });

  it('reads the exceptions of the templates from the library reads, with no new operation of its own', () => {
    const steps = own.find((one) => one.name === 'StepBands.tsx');
    expect(steps?.text).toMatch(/useTemplateCodes/);
    expect(own.some(({ text }) => /client\.(read|command)\(/.test(text) && /StepBand/.test(text))).toBe(false);
  });
});
