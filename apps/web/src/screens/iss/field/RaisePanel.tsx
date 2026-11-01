import type { Dispatch, SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useLocate } from '../../qms/offline/locate';
import { Field } from '../components';
import { issueFieldMessage, issueProblemMessage } from '../issue-labels';
import { workspaceLink } from '../issue-model';
import type { FormErrors, IssueField, ProblemView } from '../issue-model';
import { severityLabel } from '../labels';
import { SEVERITIES } from '../model';
import type { CategoryOption, UnitOption } from '../model';
import '../../qms/qms.css';
import { itemStateLabel } from './labels';
import { withConsent } from './model';
import type { ItemState, RaiseForm, RaiseItem } from './model';

export interface ItemProgress {
  state: ItemState;
  /** The issue that was opened for the item. */
  issueId?: string;
  problem?: ProblemView;
}

export interface RaisePanelProps {
  raise: RaiseForm;
  onChange: Dispatch<SetStateAction<RaiseForm>>;
  /** The problems of the shared fields, shown once the person has tried to save. */
  errors: FormErrors | undefined;
  items: readonly RaiseItem[];
  progress: Readonly<Record<string, ItemProgress | undefined>>;
  units: readonly UnitOption[];
  categories: readonly CategoryOption[];
  disabled: boolean;
}

/** The unit, the category and the severity that every issue of the inspection gets, the position with its consent, and where the issue of each failed item stands. */
export function RaisePanel({ raise, onChange, errors, items, progress, units, categories, disabled }: RaisePanelProps) {
  const { t } = useTranslation();
  const problemOf = (field: IssueField): string | undefined => {
    const found = errors?.[field];
    return found === undefined ? undefined : issueFieldMessage(t, found);
  };
  const { locating, locate } = useLocate(raise.geoConsent, (fix) =>
    onChange((current) => (current.geoConsent ? { ...current, geoLat: fix.lat, geoLng: fix.lng, geoAccuracy: fix.accuracy } : current)),
  );
  return (
    <section aria-label={t('iss.field.raise.title')} data-testid="raise-panel">
      <h2>{t('iss.field.raise.title')}</h2>
      <p className="sub">{t('iss.field.raise.hint')}</p>
      <ul className="qms-actions" data-testid="raise-items">
        {items.map((item) => (
          <li key={item.code} data-item={item.code} data-state={progress[item.code]?.state ?? 'waiting'}>
            <strong>{item.label}</strong> · {itemStateLabel(t, progress[item.code]?.state)}
            {progress[item.code]?.issueId === undefined ? null : (
              <>
                {' '}
                <Link to={workspaceLink(progress[item.code]?.issueId as string)}>{t('iss.field.item.open')}</Link>
              </>
            )}
            {progress[item.code]?.problem === undefined ? null : (
              <small role="alert" className="field-error">
                {issueProblemMessage(t, progress[item.code]?.problem as ProblemView)}
              </small>
            )}
          </li>
        ))}
      </ul>
      <fieldset disabled={disabled} className="formgrid qms-plain">
        <Field id="field-unit" label={t('iss.field.unit.label')} error={problemOf('ownerUnitId')} hint={t('iss.field.unit.hint')}>
          <select id="field-unit" value={raise.ownerUnitId} onChange={(event) => onChange({ ...raise, ownerUnitId: event.target.value })}>
            <option value="">{t('iss.field.choose.option')}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.code} · {unit.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="field-category" label={t('iss.field.category.label')} error={problemOf('categoryVersionId')}>
          <select id="field-category" value={raise.categoryVersionId} onChange={(event) => onChange({ ...raise, categoryVersionId: event.target.value })}>
            <option value="">{t('iss.field.choose.option')}</option>
            {categories.map((category) => (
              <option key={category.versionId} value={category.versionId}>
                {category.key} · {category.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="field-severity" label={t('iss.field.severity.label')} error={undefined}>
          <select id="field-severity" value={raise.severity} onChange={(event) => onChange({ ...raise, severity: SEVERITIES.find((severity) => severity === event.target.value) ?? raise.severity })}>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(t, severity)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      <fieldset disabled={disabled} className="formgrid qms-plain" aria-label={t('iss.field.geo.title')}>
        <legend>{t('iss.field.geo.title')}</legend>
        <label className="check">
          <input type="checkbox" checked={raise.geoConsent} aria-invalid={problemOf('geoConsent') !== undefined} onChange={(event) => onChange(withConsent(raise, event.target.checked))} />
          {t('iss.field.geo.consent.label')}
        </label>
        <small className="sub">{t('iss.field.geo.consent.hint')}</small>
        {problemOf('geoConsent') === undefined ? null : (
          <small role="alert" className="field-error">
            {problemOf('geoConsent')}
          </small>
        )}
        <p>
          <button type="button" className="button" disabled={!raise.geoConsent || locating === 'busy'} onClick={locate}>
            {locating === 'busy' ? t('iss.field.geo.locating.text') : t('iss.field.geo.locate.action')}
          </button>
        </p>
        {locating === 'failed' ? (
          <p className="callout warning" role="status" data-testid="locate-failed">
            {t('iss.field.geo.unavailable.notice')}
          </p>
        ) : null}
        <Field id="field-lat" label={t('iss.field.geo.lat.label')} error={problemOf('geoLat')}>
          <input id="field-lat" inputMode="decimal" value={raise.geoLat} disabled={!raise.geoConsent} onChange={(event) => onChange({ ...raise, geoLat: event.target.value })} />
        </Field>
        <Field id="field-lng" label={t('iss.field.geo.lng.label')} error={problemOf('geoLng')}>
          <input id="field-lng" inputMode="decimal" value={raise.geoLng} disabled={!raise.geoConsent} onChange={(event) => onChange({ ...raise, geoLng: event.target.value })} />
        </Field>
        <Field id="field-accuracy" label={t('iss.field.geo.accuracy.label')} error={problemOf('geoAccuracy')}>
          <input id="field-accuracy" inputMode="decimal" value={raise.geoAccuracy} disabled={!raise.geoConsent} onChange={(event) => onChange({ ...raise, geoAccuracy: event.target.value })} />
        </Field>
      </fieldset>
    </section>
  );
}
