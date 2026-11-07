import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { periodUnitText, parameterText, camel } from './ResultsPanel';
import { CATEGORIES, DELTA_KEYS, LINE_KINDS, SOURCE_KINDS, blankAssumption } from './model';
import type { Appraisal, Draft, DraftAssumption, DraftScenario } from './model';

export interface InputsPanelProps {
  appraisal: Appraisal;
  draft: Draft;
  editable: boolean;
  me: string;
  problems: readonly string[];
  onChange: (next: Draft) => void;
  onAddDefaults: () => void;
}

const SIGNED = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** The name of an input of an appraisal (HORIZON, DISCOUNT_RATE, CAPEX, SCENARIO:ADVERSE) as the screen says it. */
export function assumptionName(t: (key: string, params?: Record<string, string | number>) => string, key: string): string {
  return key.startsWith('SCENARIO:') ? t('fin1.assume.scenario', { code: key.slice('SCENARIO:'.length) }) : t(`fin1.assume.${camel(key)}`);
}

/**
 * The inputs of an appraisal, all of them typed by people: the parameters, the cash flow per period (exact decimals, ĐVT stated), who answers for each input and where it comes from, the scenarios as deltas
 * and the scores of the criteria. The grid has no cell for a result: NPV, IRR, payback, B/C and TCO are computed by the server from these inputs and nowhere else. A draft is the only thing that may be edited.
 */
export function InputsPanel({ appraisal, draft, editable, me, problems, onChange, onAddDefaults }: InputsPanelProps) {
  const { t } = useTranslation();
  const bad = (field: string): boolean => problems.includes(field);
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch });
  const unit = periodUnitText(t, draft.periodUnit);
  const peopleMap = new Map<string, string>();
  const addPerson = (personId: string, label: string): void => {
    if (personId !== '' && !peopleMap.has(personId)) peopleMap.set(personId, label);
  };
  addPerson(me, t('fin1.owner.me'));
  addPerson(appraisal.createdBy.id, appraisal.createdBy.name ?? appraisal.createdBy.id);
  addPerson(appraisal.updatedBy.id, appraisal.updatedBy.name ?? appraisal.updatedBy.id);
  for (const entry of appraisal.assumptions) addPerson(entry.ownerId, entry.ownerName ?? entry.ownerId);
  const people = [...peopleMap.entries()];
  const keys = [...new Set([...appraisal.requiredAssumptions, ...draft.assumptions.map((entry) => entry.key)])];
  // The inputs that are required by what the draft says now (a kind of line with an amount, a scenario), so the list follows the grid and not the last save.
  const used = new Set<string>(['HORIZON', 'DISCOUNT_RATE']);
  for (const kind of LINE_KINDS) if (draft.lines.some((line) => /[1-9]/.test(line[kind]))) used.add(kind.toUpperCase());
  for (const scenario of draft.scenarios) used.add(`SCENARIO:${scenario.code}`);
  const shown = keys.filter((key) => used.has(key) || draft.assumptions.some((entry) => entry.key === key));
  for (const key of used) if (!shown.includes(key)) shown.push(key);

  const setLine = (index: number, patch: Partial<Draft['lines'][number]>): void => set({ lines: draft.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)) });
  const addLine = (): void => {
    const next = draft.lines.reduce((highest, line) => Math.max(highest, /^\d+$/.test(line.period) ? Number(line.period) : -1), -1) + 1;
    set({ lines: [...draft.lines, { period: String(next), benefit: '', capex: '', opex: '', maintenance: '', residual: '' }] });
  };
  const setAssumption = (key: string, patch: Partial<DraftAssumption>): void => {
    const exists = draft.assumptions.some((entry) => entry.key === key);
    set({ assumptions: exists ? draft.assumptions.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)) : [...draft.assumptions, { ...blankAssumption(key, me), ...patch }] });
  };
  const setScenario = (index: number, patch: Partial<DraftScenario>): void => set({ scenarios: draft.scenarios.map((scenario, at) => (at === index ? { ...scenario, ...patch } : scenario)) });
  const setDelta = (index: number, key: string, value: string): void => setScenario(index, { deltas: { ...(draft.scenarios[index]?.deltas ?? {}), [key]: value.trim() } });
  const setScore = (key: string, patch: Partial<Draft['scores'][number]>): void => {
    const exists = draft.scores.some((entry) => entry.key === key);
    set({ scores: exists ? draft.scores.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)) : [...draft.scores, { key, score: '', evidence: '', ...patch }] });
  };
  const criteria = appraisal.criteriaInForce;

  return (
    <>
      <SectionCard title={t('fin1.params.title')} unit={t('fin1.unit.vnd')}>
        <div className="fin1-form" role="group" aria-label={t('fin1.params.title')}>
          <label className="fin1-field">
            {t('fin1.params.name')}
            <input value={draft.title} disabled={!editable} onChange={(event) => set({ title: event.target.value })} data-testid="title" aria-invalid={bad('title')} />
          </label>
          <label className="fin1-field">
            {t('fin1.params.unit')}
            <select value={draft.periodUnit} disabled={!editable} onChange={(event) => set({ periodUnit: event.target.value })} data-testid="period-unit">
              <option value="YEAR">{t('fin1.unit.year')}</option>
              <option value="QUARTER">{t('fin1.unit.quarter')}</option>
              <option value="MONTH">{t('fin1.unit.month')}</option>
            </select>
          </label>
          <label className="fin1-field">
            {t('fin1.params.rate', { unit })}
            <input inputMode="decimal" value={draft.discountRatePct} disabled={!editable} onChange={(event) => set({ discountRatePct: event.target.value.trim() })} data-testid="rate" aria-invalid={bad('rate')} />
          </label>
          <label className="fin1-field">
            {t('fin1.params.convention')}
            <select value={draft.convention} disabled={!editable} onChange={(event) => set({ convention: event.target.value })} data-testid="convention">
              <option value="END">{t('fin1.params.convention.end')}</option>
              <option value="MID">{t('fin1.params.convention.mid')}</option>
            </select>
          </label>
        </div>
        <p className="muted">{t('fin1.params.rateNote')}</p>
      </SectionCard>

      <SectionCard
        title={t('fin1.lines.title')}
        unit={t('fin1.unit.vnd')}
        actions={
          editable ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={addLine} data-testid="add-line">
              {t('fin1.lines.add')}
            </button>
          ) : undefined
        }
      >
        {draft.lines.length === 0 ? (
          <p className="callout" role="status" data-testid="no-lines">
            {t('fin1.lines.empty')}
          </p>
        ) : (
          <div className="fin1-scroll" tabIndex={0} role="region" aria-label={t('fin1.lines.title')}>
            <table className="fin1-grid" data-testid="lines">
              <caption className="sr-only">{t('fin1.lines.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('fin1.lines.period', { unit })}</th>
                  {LINE_KINDS.map((kind) => (
                    <th key={kind} scope="col">
                      {t(`fin1.line.${kind}`)}
                    </th>
                  ))}
                  {editable ? <th scope="col">{t('fin1.lines.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line, index) => (
                  <tr key={index} data-period={line.period}>
                    <th scope="row">
                      <input className="fin1-cell" value={line.period} disabled={!editable} inputMode="numeric" aria-label={t('fin1.lines.periodOf', { row: index + 1 })} onChange={(event) => setLine(index, { period: event.target.value.trim() })} aria-invalid={bad(`line.${index}.period`)} data-testid={`period-${index}`} />
                    </th>
                    {LINE_KINDS.map((kind) => (
                      <td key={kind}>
                        <input
                          className="fin1-cell fin1-num"
                          value={line[kind]}
                          disabled={!editable}
                          inputMode="decimal"
                          aria-label={t('fin1.lines.cell', { kind: t(`fin1.line.${kind}`), row: index + 1 })}
                          onChange={(event) => setLine(index, { [kind]: event.target.value.trim() })}
                          aria-invalid={bad(`line.${index}.${kind}`)}
                          data-testid={`${kind}-${index}`}
                        />
                      </td>
                    ))}
                    {editable ? (
                      <td>
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => set({ lines: draft.lines.filter((_, at) => at !== index) })} data-testid={`remove-${index}`}>
                          {t('fin1.lines.remove')}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">{t('fin1.lines.note')}</p>
      </SectionCard>

      <SectionCard title={t('fin1.assume.title')} status={appraisal.missingAssumptions.length > 0 && editable ? <StatusPill tone="warning">{t('fin1.assume.missing', { count: appraisal.missingAssumptions.length })}</StatusPill> : undefined}>
        <p className="muted">{t('fin1.assume.note')}</p>
        <div className="fin1-scroll" tabIndex={0} role="region" aria-label={t('fin1.assume.title')}>
          <table className="fin1-grid" data-testid="assumptions">
            <caption className="sr-only">{t('fin1.assume.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('fin1.assume.input')}</th>
                <th scope="col">{t('fin1.assume.value')}</th>
                <th scope="col">{t('fin1.assume.unit')}</th>
                <th scope="col">{t('fin1.assume.sourceKind')}</th>
                <th scope="col">{t('fin1.assume.source')}</th>
                <th scope="col">{t('fin1.assume.owner')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((key) => {
                const index = draft.assumptions.findIndex((entry) => entry.key === key);
                const entry = index < 0 ? blankAssumption(key, me) : (draft.assumptions[index] as DraftAssumption);
                const name = assumptionName(t, key);
                return (
                  <tr key={key} data-input={key} data-answered={index >= 0 ? 'yes' : 'no'}>
                    <th scope="row">{name}</th>
                    <td>
                      <input className="fin1-cell" value={entry.value} disabled={!editable} aria-label={t('fin1.assume.valueOf', { name })} onChange={(event) => setAssumption(key, { value: event.target.value })} data-testid={`assume-value-${key}`} aria-invalid={bad(`assumption.${index}`)} />
                    </td>
                    <td>
                      <input className="fin1-cell" value={entry.unit} disabled={!editable} aria-label={t('fin1.assume.unitOf', { name })} onChange={(event) => setAssumption(key, { unit: event.target.value })} data-testid={`assume-unit-${key}`} />
                    </td>
                    <td>
                      <select className="fin1-cell" value={entry.sourceKind} disabled={!editable} aria-label={t('fin1.assume.sourceKindOf', { name })} onChange={(event) => setAssumption(key, { sourceKind: event.target.value })} data-testid={`assume-kind-${key}`}>
                        {SOURCE_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`fin1.source.${kind.toLowerCase()}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="fin1-cell" value={entry.source} disabled={!editable} aria-label={t('fin1.assume.sourceOf', { name })} onChange={(event) => setAssumption(key, { source: event.target.value })} data-testid={`assume-source-${key}`} />
                    </td>
                    <td>
                      <select className="fin1-cell" value={entry.ownerId} disabled={!editable} aria-label={t('fin1.assume.ownerOf', { name })} onChange={(event) => setAssumption(key, { ownerId: event.target.value })} data-testid={`assume-owner-${key}`}>
                        {people.map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">{t('fin1.assume.law')}</p>
      </SectionCard>

      <SectionCard
        title={t('fin1.scenarios.title')}
        actions={
          editable ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onAddDefaults} data-testid="add-defaults">
              {t('fin1.scenarios.defaults')}
            </button>
          ) : undefined
        }
      >
        <p className="muted">{t('fin1.scenarios.note')}</p>
        {draft.scenarios.length === 0 ? <p className="callout">{t('fin1.scenarios.none')}</p> : null}
        {draft.scenarios.map((scenario, index) => (
          <fieldset key={index} className="fin1-scenario" data-scenario={scenario.code}>
            <legend>{scenario.label === '' ? scenario.code : scenario.label}</legend>
            <div className="fin1-form">
              <label className="fin1-field">
                {t('fin1.scenarios.code')}
                <input value={scenario.code} disabled={!editable} onChange={(event) => setScenario(index, { code: event.target.value.trim().toUpperCase() })} aria-invalid={bad(`scenario.${index}.code`)} data-testid={`scenario-code-${index}`} />
              </label>
              <label className="fin1-field">
                {t('fin1.scenarios.label')}
                <input value={scenario.label} disabled={!editable} onChange={(event) => setScenario(index, { label: event.target.value })} aria-invalid={bad(`scenario.${index}.label`)} data-testid={`scenario-label-${index}`} />
              </label>
              {DELTA_KEYS.map((key) => (
                <label key={key} className="fin1-field">
                  {parameterText(t, key)}
                  <input inputMode="decimal" value={scenario.deltas[key] ?? ''} disabled={!editable} onChange={(event) => setDelta(index, key, event.target.value)} aria-invalid={bad(`scenario.${index}.${key}`) || ((scenario.deltas[key] ?? '') !== '' && !SIGNED.test(scenario.deltas[key] ?? ''))} data-testid={`scenario-${index}-${key}`} />
                </label>
              ))}
            </div>
            {editable ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => set({ scenarios: draft.scenarios.filter((_, at) => at !== index) })} data-testid={`scenario-remove-${index}`}>
                {t('fin1.scenarios.remove')}
              </button>
            ) : null}
          </fieldset>
        ))}
        {editable ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => set({ scenarios: [...draft.scenarios, { code: '', label: '', deltas: {} }] })} data-testid="add-scenario">
            {t('fin1.scenarios.add')}
          </button>
        ) : null}
      </SectionCard>

      <SectionCard title={t('fin1.criteria.title')} status={criteria === null ? undefined : <StatusPill tone={criteria.unverified ? 'warning' : 'info'}>{criteria.source === 'RULE' ? t('fin1.criteria.rule', { version: criteria.version }) : t('fin1.criteria.default')}</StatusPill>}>
        <p className="muted">{t('fin1.criteria.note')}</p>
        <label className="fin1-field">
          {t('fin1.criteria.category')}
          <select value={draft.criteriaCategory} disabled={!editable} onChange={(event) => set({ criteriaCategory: event.target.value, scores: [] })} data-testid="category">
            <option value="">{t('fin1.criteria.none')}</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`fin1.category.${category.toLowerCase()}`)}
              </option>
            ))}
          </select>
        </label>
        {criteria !== null && criteria.category === draft.criteriaCategory ? (
          <div className="fin1-scroll" tabIndex={0} role="region" aria-label={t('fin1.criteria.title')}>
            <table className="fin1-grid" data-testid="criteria">
              <caption className="sr-only">{t('fin1.criteria.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('fin1.criteria.name')}</th>
                  <th scope="col">{t('fin1.criteria.weight')}</th>
                  <th scope="col">{t('fin1.criteria.score')}</th>
                  <th scope="col">{t('fin1.criteria.evidence')}</th>
                </tr>
              </thead>
              <tbody>
                {criteria.criteria.map((one) => {
                  const entry = draft.scores.find((score) => score.key === one.key) ?? { key: one.key, score: '', evidence: '' };
                  return (
                    <tr key={one.key} data-criterion={one.key}>
                      <th scope="row">{one.label}</th>
                      <td className="fin1-num">{one.weightPct}%</td>
                      <td>
                        <select className="fin1-cell" value={entry.score} disabled={!editable} aria-label={t('fin1.criteria.scoreOf', { name: one.label })} onChange={(event) => setScore(one.key, { score: event.target.value })} data-testid={`score-${one.key}`}>
                          <option value="">{t('fin1.criteria.noScore')}</option>
                          {[1, 2, 3, 4, 5].map((value) => (
                            <option key={value} value={String(value)}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input className="fin1-cell" value={entry.evidence} disabled={!editable} aria-label={t('fin1.criteria.evidenceOf', { name: one.label })} onChange={(event) => setScore(one.key, { evidence: event.target.value })} data-testid={`evidence-${one.key}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {draft.criteriaCategory !== '' && (criteria === null || criteria.category !== draft.criteriaCategory) ? (
          <p className="callout" role="status" data-testid="save-first">
            {t('fin1.criteria.saveFirst')}
          </p>
        ) : null}
        {criteria !== null && criteria.unverified ? <p className="muted">{t('fin1.criteria.unverified')}</p> : null}
      </SectionCard>
    </>
  );
}
