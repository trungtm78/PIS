import { FND_FIGURE_BUSINESS_TYPE, IND_ENTRY_BUSINESS_TYPE, enabledBusinessTypes } from '@machvon/kernel';
import { FndFigureApprovalBinding } from '../../src/modules/fnd/figure-approval.binding';
import { IndEntryApprovalBinding } from '../../src/modules/ind/entry-approval.binding';
import { ApprovalPushSources } from '../../src/modules/adm/approval-hold.service';
import { FinalCommandRegistry } from '../../src/modules/adm/approval.service';

const PRODUCTION = { NODE_ENV: 'production', MACHVON_APPROVAL_BUSINESS_TYPES: `${FND_FIGURE_BUSINESS_TYPE},${IND_ENTRY_BUSINESS_TYPE}` };
const MOUNTED = ['ADM', 'DIS', 'FND', 'IND'];

/** R14 for the owners ENT-3c added: a production process that enables the staged approval of figure batches or entry batches does not boot without the real final command of each. */
describe('the boot guard for the staged approval of FND and IND (R14)', () => {
  it('names the enabled types that have no real handler, and nothing once the bindings registered theirs', () => {
    const registry = new FinalCommandRegistry({ variables: PRODUCTION });
    const enabled = enabledBusinessTypes(PRODUCTION, MOUNTED);
    expect(enabled).toEqual(['report.accept', 'fnd.figures.accept', 'ind.entry.accept']);
    expect(registry.missingHandlers(enabled, PRODUCTION)).toEqual(['report.accept', 'fnd.figures.accept', 'ind.entry.accept']);
    const sources = new ApprovalPushSources();
    new FndFigureApprovalBinding(registry, sources, 'PUBLIC');
    expect(registry.missingHandlers(enabled, PRODUCTION)).toEqual(['report.accept', 'ind.entry.accept']);
    new IndEntryApprovalBinding(registry, sources);
    expect(registry.missingHandlers(enabled, PRODUCTION)).toEqual(['report.accept']);
    expect(registry.hasRealHandler(FND_FIGURE_BUSINESS_TYPE)).toBe(true);
    expect(registry.hasRealHandler(IND_ENTRY_BUSINESS_TYPE)).toBe(true);
  });

  it('leaves the two owners out of the enabled types unless the configuration names them, so a deployment that never opted in boots as before', () => {
    expect(enabledBusinessTypes({ NODE_ENV: 'production' }, MOUNTED)).toEqual(['report.accept']);
  });

  it('registers what each owner hands over at its PUSH step, by the resource type of the instance', () => {
    const registry = new FinalCommandRegistry({ variables: PRODUCTION });
    const sources = new ApprovalPushSources();
    new FndFigureApprovalBinding(registry, sources, 'PUBLIC');
    new IndEntryApprovalBinding(registry, sources);
    expect(sources.of('plan_figure_batch')).toMatchObject({ owner: 'FND_FIGURE', layoutBase: 'FND_FIGURES' });
    expect(sources.of('ind_entry_batch')).toMatchObject({ owner: 'IND_ENTRY', layoutBase: 'IND_ENTRIES' });
    expect(sources.of('report_revision')).toBeUndefined();
  });
});
