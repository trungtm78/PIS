import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels, Tone } from '../../ui';
import { figureReason, figureText } from './model';
import type { FigureFlag, Tile } from './model';
import { dayText } from './overview-model';

type T = Translator['t'];

/** Why a figure is missing, in words (never 0): the reasons of the server, the two of the certification, and a general one for any other. */
export function reasonLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'NO_DATA':
      return t('home.tile.nullReason.noData');
    case 'ZERO_DENOMINATOR':
      return t('home.tile.nullReason.zeroDenominator');
    case 'TREASURY_COVERAGE_NONE':
      return t('home.tile.nullReason.treasuryNone');
    case 'NOT_CERTIFIED':
      return t('govc.home.reason.notCertified');
    case 'OBSOLETE':
      return t('govc.home.reason.obsolete');
    default:
      return t('home.tile.nullReason.other');
  }
}

/** The words for a figure that has no text: the reason the server gave. */
export const noneText = (t: T, tile: Pick<Tile, 'nullReason' | 'flags'>): string => reasonLabel(t, figureReason(tile));

/** What a figure says in one string: the text of the server and its unit, or why there is none. Never a number the server did not write. */
export function figureShown(t: T, tile: Tile): string {
  if (tile.displayValue === null) return noneText(t, tile);
  const text = figureText(tile);
  if (tile.unit === 'PERCENT') return t('home.tile.value.percent', { value: text });
  if (tile.unit === 'VND') return t('home.tile.value.vnd', { value: text });
  return text;
}

const FLAG_TONE: Record<FigureFlag, Tone> = { NO_DATA: 'neutral', NOT_CERTIFIED: 'warning', OBSOLETE: 'danger', STALE: 'warning', PARTIAL_COVERAGE: 'warning', UNVERIFIED_DEFINITION: 'warning' };

function flagLabel(t: T, flag: FigureFlag): string {
  switch (flag) {
    case 'NO_DATA':
      return t('govc.home.flag.noData');
    case 'NOT_CERTIFIED':
      return t('govc.home.flag.notCertified');
    case 'OBSOLETE':
      return t('govc.home.flag.obsolete');
    case 'STALE':
      return t('govc.home.flag.stale');
    case 'PARTIAL_COVERAGE':
      return t('govc.home.flag.partialCoverage');
    case 'UNVERIFIED_DEFINITION':
      return t('govc.home.flag.unverifiedDefinition');
  }
}

/** The flags that sit on a figure, each as a text pill. A flag that only repeats the words already said in place of the number (no data, not certified, obsolete) is not said twice. */
export function FlagPills({ tile }: { tile: Pick<Tile, 'flags' | 'displayValue' | 'nullReason' | 'metricCode'> }) {
  const { t } = useTranslation();
  const said = tile.displayValue === null ? figureReason(tile as Pick<Tile, 'nullReason' | 'flags'>) : null;
  const flags = tile.flags.filter((flag) => flag !== said);
  if (flags.length === 0) return null;
  return (
    <span className="home-flags" data-testid={`flags-${tile.metricCode}`}>
      {flags.map((flag) => (
        <StatusPill key={flag} tone={FLAG_TONE[flag]}>
          {flagLabel(t, flag)}
        </StatusPill>
      ))}
    </span>
  );
}

/** The "i" of a figure (G0-4): the definition of the register behind the number, in the words of the screen. A figure with no definition behind it (an older server) has no "i" rather than an empty one. */
export function FigureInfo({ tile }: { tile: Pick<Tile, 'kpi' | 'metricCode'> }) {
  const { t } = useTranslation();
  const kpi = tile.kpi;
  if (kpi === null) return null;
  const labels: InfoFormulaLabels = {
    open: t('govc.home.info.open', { name: kpi.name }),
    close: t('govc.home.info.close'),
    formula: t('govc.home.info.formula'),
    numerator: t('govc.home.info.numerator'),
    denominator: t('govc.home.info.denominator'),
    exclusions: t('govc.home.info.exclusions'),
    source: t('govc.home.info.source'),
    asOf: t('govc.home.info.asOf'),
    owner: t('govc.home.info.owner'),
    version: t('govc.home.info.version.label'),
    unverified: t('govc.home.info.unverified'),
  };
  return (
    <span className="home-info" data-testid={`info-${tile.metricCode}`}>
      <InfoFormula
        name={kpi.name}
        formula={kpi.formula}
        numerator={kpi.numerator}
        denominator={kpi.denominator}
        exclusions={kpi.exclusions}
        source={kpi.source === '' ? '—' : kpi.source}
        asOf={kpi.asOf === '' ? '—' : dayText(kpi.asOf)}
        owner={kpi.owner === '' ? '—' : kpi.owner}
        version={kpi.origin === 'DEFAULT' ? t('govc.home.info.version.default', { version: kpi.version }) : t('govc.home.info.version', { version: kpi.version })}
        unverified={kpi.unverified}
        labels={labels}
      />
    </span>
  );
}
