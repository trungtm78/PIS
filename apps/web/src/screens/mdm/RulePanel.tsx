import { useTranslation } from '../../i18n';
import { camel } from './catalogues';
import type { RecordView } from './model';

type Row = Record<string, unknown>;

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((item): item is Row => typeof item === 'object' && item !== null && !Array.isArray(item)) : []);
const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

/** An amount in VND from its decimal string: the digits are grouped by the language of the screen and the string is never turned into a float. */
export function amountText(amount: string, locale: string): string {
  const [whole = '', fraction] = amount.split('.');
  if (!/^\d+$/.test(whole)) return amount;
  const format = new Intl.NumberFormat(locale);
  const grouped = format.format(BigInt(whole));
  // The cents keep their exact digits; only the separator is the language's own.
  const separator = format.formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return fraction === undefined ? grouped : `${grouped}${separator}${fraction}`;
}

function Thresholds({ bands }: { bands: Row[] }) {
  const { t, locale } = useTranslation();
  return (
    <table className="table" data-testid="bands">
      <thead>
        <tr>
          <th>{t('mdm.rule.bands.sector.column')}</th>
          <th>{t('mdm.rule.bands.group.column')}</th>
          <th>{t('mdm.rule.bands.from.column')}</th>
          <th>{t('mdm.rule.bands.to.column')}</th>
        </tr>
      </thead>
      <tbody>
        {bands.map((band, index) => (
          <tr key={`${text(band.sector_key)}:${text(band.group_key)}:${index}`}>
            <td>{typeof band.sector_key === 'string' ? band.sector_key : t('mdm.rule.bands.default.text')}</td>
            <td>{text(band.group_key)}</td>
            <td>{amountText(text(band.min_amount), locale)}</td>
            <td>{typeof band.max_amount === 'string' ? amountText(band.max_amount, locale) : t('mdm.rule.bands.open.text')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Value({ record }: { record: RecordView }) {
  const { t } = useTranslation();
  const { attributes } = record;
  switch (record.masterType) {
    case 'PROJECT_GROUP_THRESHOLDS':
      return <Thresholds bands={rowsOf(attributes.bands)} />;
    case 'NATIONAL_CODE_REQUIRED':
      return <p data-testid="national-code-mode">{t('mdm.rule.mode.text', { mode: t(`mdm.value.ruleMode.${camel(text(attributes.mode))}`), stage: text(attributes.from_stage_key) })}</p>;
    case 'NATIONAL_CODE_FORMAT':
      return (
        <p data-testid="national-code-format">
          {t('mdm.rule.format.text', { pattern: text(attributes.pattern), example: text(attributes.example) })}
        </p>
      );
    case 'APPRAISAL_CRITERIA':
      return (
        <>
          <ul className="plain" data-testid="criteria">
            {rowsOf(attributes.criteria).map((criterion) => (
              <li key={text(criterion.code)}>{t('mdm.rule.criteria.item', { name: text(criterion.name), score: text(criterion.max_score) })}</li>
            ))}
          </ul>
          <p>{t('mdm.rule.threshold.text', { score: text(attributes.pass_threshold) })}</p>
        </>
      );
    default:
      return null;
  }
}

/**
 * The rule data that applies to the entries of a catalogue (BR-MDM-09): each rule with the legal basis it stands on, the dates it is in
 * force, the module that owns it and, while its confirmation has not arrived, the badge that every screen applying it must show.
 */
export function RulePanel({ rules }: { rules: readonly RecordView[] }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-label={t('mdm.rule.panel.title')} data-testid="rules">
      <h2>{t('mdm.rule.panel.title')}</h2>
      {rules.length === 0 ? <p className="muted">{t('mdm.rule.empty.text')}</p> : null}
      {rules.map((rule) => {
        const awaiting = rule.attributes.awaiting_confirmation === true;
        return (
          <article key={rule.id} className="rule" data-rule-type={rule.masterType} data-awaiting={awaiting ? 'true' : 'false'}>
            <h3>
              {rule.label ?? rule.businessKey}{' '}
              {awaiting ? <span className="pill warn">{t('mdm.rule.awaiting.pill', { cxn: text(rule.attributes.cxn) })}</span> : <span className="pill green">{t('mdm.rule.confirmed.pill')}</span>}
            </h3>
            <Value record={rule} />
            <dl>
              <dt>{t('mdm.rule.legalBasis.label')}</dt>
              <dd>{rule.legalBasis ?? ''}</dd>
              <dt>{t('mdm.rule.validity.label')}</dt>
              <dd>{rule.validFrom === null ? '' : `${rule.validFrom} → ${rule.validUntil ?? t('mdm.rule.open.text')}`}</dd>
              <dt>{t('mdm.rule.owner.label')}</dt>
              <dd>{text(rule.attributes.owner_module)}</dd>
            </dl>
          </article>
        );
      })}
    </section>
  );
}
