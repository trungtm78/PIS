import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { ScrollRegion } from '../../scroll-region';
import { docTypeName, kpiName, roleName } from '../codes';
import { gateWord, kindWord, priorityWord } from '../labels';
import type { GateTarget, Priority, TaskKind } from '../model';
import { compareStructured } from './compare-model';
import type { ChangeKind, CompareTotals, DiffValue, FieldDiff, ItemDiff, Tier } from './compare-model';
import { stepsOf } from './template-model';
import type { Template } from './template-model';

type T = Translator['t'];

const LOOK: Readonly<Record<ChangeKind, { tone: 'success' | 'danger' | 'warning'; icon: string }>> = { added: { tone: 'success', icon: '+' }, removed: { tone: 'danger', icon: '−' }, changed: { tone: 'warning', icon: '~' } };

function kindText(t: T, kind: ChangeKind): string {
  switch (kind) {
    case 'added':
      return t('pwf.templates.change.added.word');
    case 'removed':
      return t('pwf.templates.change.removed.word');
    case 'changed':
      return t('pwf.templates.change.changed.word');
  }
}

function tierText(t: T, tier: Tier): string {
  switch (tier) {
    case 'template':
      return t('pwf.templates.scope.template.word');
    case 'phase':
      return t('pwf.templates.scope.phase.word');
    case 'step':
      return t('pwf.templates.scope.step.word');
    case 'task':
      return t('pwf.templates.scope.task.word');
  }
}

interface Names {
  phase: (code: string) => string;
  step: (code: string | null) => string;
}

function valueText(t: T, value: DiffValue | undefined, names: Names): string {
  if (value === undefined) return '';
  switch (value.type) {
    case 'text':
      return value.text;
    case 'days':
      return t('pwf6.cmp.days.text', { days: value.days });
    case 'role':
      return value.code === null ? t('pwf6.cmp.none.text') : roleName(t, value.code);
    case 'phase':
      return names.phase(value.code);
    case 'step':
      return names.step(value.code);
    case 'flag':
      return value.on ? t('pwf6.cmp.yes.text') : t('pwf6.cmp.no.text');
    case 'enum':
      return value.group === 'kind' ? kindWord(t, value.code as TaskKind) : priorityWord(t, value.code as Priority);
    case 'none':
      return t('pwf6.cmp.none.text');
  }
}

/** A list item of a field in words: a document type, a KPI or a gate by its name; anything else as it is. */
function itemText(t: T, field: FieldDiff['field'], item: string): string {
  if (field === 'legalDocs') return docTypeName(t, item);
  if (field === 'kpi') return kpiName(t, item);
  if (field === 'gates') return gateWord(t, item as GateTarget);
  return item;
}

function FieldRow({ diff, names }: { diff: FieldDiff; names: Names }) {
  const { t } = useTranslation();
  const list = diff.added !== undefined || diff.removed !== undefined || diff.changed !== undefined;
  return (
    <tr data-field={diff.field}>
      <th scope="row">{t(`pwf6.cmp.field.${diff.field}`)}</th>
      {list ? (
        <td colSpan={2}>
          <ul className="pwf-cmp__list">
            {(diff.added ?? []).map((item) => (
              <li key={`+${item}`} data-kind="added">
                <span aria-hidden="true">+</span> <span className="ui-sr-only">{t('pwf.templates.change.added.word')}: </span>
                {itemText(t, diff.field, item)}
              </li>
            ))}
            {(diff.removed ?? []).map((item) => (
              <li key={`-${item}`} data-kind="removed">
                <span aria-hidden="true">−</span> <span className="ui-sr-only">{t('pwf.templates.change.removed.word')}: </span>
                {itemText(t, diff.field, item)}
              </li>
            ))}
            {(diff.changed ?? []).map((item) => (
              <li key={`~${item}`} data-kind="changed">
                <span aria-hidden="true">~</span> <span className="ui-sr-only">{t('pwf.templates.change.changed.word')}: </span>
                {itemText(t, diff.field, item)}
              </li>
            ))}
          </ul>
        </td>
      ) : (
        <>
          <td className="pwf-cmp__before">{valueText(t, diff.before, names)}</td>
          <td className="pwf-cmp__after">{valueText(t, diff.after, names)}</td>
        </>
      )}
    </tr>
  );
}

function Item({ item, names, left, right }: { item: ItemDiff; names: Names; left: string; right: string }) {
  const { t } = useTranslation();
  const look = LOOK[item.kind];
  return (
    <li className="pwf-cmp__item" data-kind={item.kind} data-tier={item.tier} data-code={item.code}>
      <div className="pwf-cmp__head">
        <StatusPill tone={look.tone} icon={look.icon}>
          {kindText(t, item.kind)}
        </StatusPill>
        <span className="pwf-hint">{tierText(t, item.tier)}</span>
        <strong>{item.name === '' ? item.code : item.name}</strong>
        {item.code === '' || item.code === item.name ? null : <span className="pwf-code">{item.code}</span>}
      </div>
      {item.fields.length === 0 ? null : (
        <table className="pwf-cmp__fields">
          <thead>
            <tr>
              <th scope="col">{t('pwf6.cmp.col.field')}</th>
              <th scope="col">{left}</th>
              <th scope="col">{right}</th>
            </tr>
          </thead>
          <tbody>
            {item.fields.map((diff) => (
              <FieldRow key={diff.field} diff={diff} names={names} />
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

const TOTALS: readonly (keyof CompareTotals)[] = ['phases', 'steps', 'tasks', 'days', 'checklist', 'legalBasis', 'forms'];

/**
 * Two versions of a workflow template compared as a procedure (PWF-01): the sizes of both side by side with the difference, then phase by phase what was added, removed or changed, each change with the value before and after
 * in words. The raw parameters stay on the general screen of the rule store for whoever needs them.
 */
export function TemplateCompare({ before, after, left, right }: { before: Template; after: Template; left: string; right: string }) {
  const { t } = useTranslation();
  const result = compareStructured(before, after);
  const phaseNames = new Map([...before.phases, ...after.phases].map((phase) => [phase.code, phase.name]));
  const stepNames = new Map([...stepsOf(before), ...stepsOf(after)].map((step) => [step.code, step.name]));
  const names: Names = { phase: (code) => phaseNames.get(code) ?? code, step: (code) => (code === null ? t('pwf6.cmp.none.text') : (stepNames.get(code) ?? code)) };
  const phases = [...new Set(result.items.map((item) => item.phase))];
  return (
    <div className="pwf-cmp" data-testid="compare-structured">
      <ScrollRegion label={t('pwf6.cmp.totals.caption')}>
        <table className="pwf-outline pwf-outline--flat pwf-cmp__totals" data-testid="compare-totals">
          <caption className="ui-sr-only">{t('pwf6.cmp.totals.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('pwf6.cmp.col.measure')}</th>
              <th scope="col" className="pwf-num">
                {left}
              </th>
              <th scope="col" className="pwf-num">
                {right}
              </th>
              <th scope="col" className="pwf-num">
                {t('pwf6.cmp.col.delta')}
              </th>
            </tr>
          </thead>
          <tbody>
            {TOTALS.map((key) => {
              const delta = result.after[key] - result.before[key];
              return (
                <tr key={key} data-total={key}>
                  <th scope="row">{t(`pwf6.cmp.total.${key}`)}</th>
                  <td className="pwf-num">{result.before[key]}</td>
                  <td className="pwf-num">{result.after[key]}</td>
                  <td className="pwf-num" data-delta={delta === 0 ? 'none' : delta > 0 ? 'up' : 'down'}>
                    {delta === 0 ? t('pwf6.cmp.delta.none') : delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      {result.items.length === 0 ? (
        <p className="callout" role="status" data-testid="compare-same">
          {t('pwf.templates.compare.same.text')}
        </p>
      ) : (
        <>
          <p className="pwf-pills" data-testid="compare-counts">
            <StatusPill tone="success" icon="+">
              {t('pwf6.cmp.count.added', { count: result.counts.added })}
            </StatusPill>
            <StatusPill tone="danger" icon="−">
              {t('pwf6.cmp.count.removed', { count: result.counts.removed })}
            </StatusPill>
            <StatusPill tone="warning" icon="~">
              {t('pwf6.cmp.count.changed', { count: result.counts.changed })}
            </StatusPill>
          </p>
          <div data-testid="compare-changes">
            {phases.map((phase) => (
              <section key={phase === '' ? '(template)' : phase} className="pwf-cmp__phase" data-phase={phase}>
                <h3>{phase === '' ? t('pwf.templates.scope.template.word') : names.phase(phase)}</h3>
                <ul className="pwf-cmp__items">
                  {result.items
                    .filter((item) => item.phase === phase)
                    .map((item) => (
                      <Item key={`${item.tier}:${item.code}:${item.kind}`} item={item} names={names} left={left} right={right} />
                    ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
