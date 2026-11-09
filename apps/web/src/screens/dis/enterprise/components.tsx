import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { KpiTile } from '../../../ui';
import type { Tone } from '../../../ui';
import { FigureInfo } from '../funding/components';
import { DETAIL_PATH, NONE, camel, missingCells, money, monthsText, percent } from './model';
import type { MissingUnit, Rate, SnapshotStatus, WaitingBatch } from './model';
import '../funding/funding.css';
import './enterprise.css';

/** The units that have not submitted, then the projects and the cells with the months that lack an accepted actual (the list a refused build gives). */
export function MissingUnits({ units }: { units: readonly MissingUnit[] }) {
  const { t } = useTranslation();
  if (units.length === 0) return null;
  return (
    <div className="dis-ent-missing" data-testid="missing-units">
      <p>{t('ent3a.build.missing.summary', { units: units.length, cells: missingCells(units) })}</p>
      <ul className="dis-ent-units">
        {units.map((unit) => (
          <li key={unit.unit_id}>
            <strong>{unit.unit_code}</strong>
            <ul>
              {unit.projects.map((project) => (
                <li key={project.project_id}>
                  <span>{project.project_code}</span>
                  <ul>
                    {project.cells.map((cell) => (
                      <li key={`${cell.class_code}/${cell.tier_code}/${cell.measure}`}>
                        {t('ent3a.build.missing.cell', { class: cell.class_code, measure: t(`dis.funding.measure.${camel(cell.measure)}`), months: monthsText(cell.months) })}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The batches that still wait for acceptance: the accepted ones are what a snapshot is built from. */
export function WaitingBatches({ batches }: { batches: readonly WaitingBatch[] }) {
  const { t } = useTranslation();
  if (batches.length === 0) return null;
  return (
    <div className="dis-ent-missing" data-testid="waiting-batches">
      <p>{t('ent3a.build.waiting.summary', { count: batches.length })}</p>
      <ul>
        {batches.map((batch) => (
          <li key={batch.batch_id}>{batch.project_code}</li>
        ))}
      </ul>
    </div>
  );
}

/** The rate as a percent with the sum of the parts above and below the line, or the reason nobody has it; never a zero that stands for "no data". */
export function RateText({ rate }: { rate: Rate | undefined }) {
  const { t } = useTranslation();
  if (rate === undefined) return <span>{NONE}</span>;
  return (
    <span data-testid={`rate-${rate.code}`}>
      {percent(rate.rate_pct)}
      <small className="dis-funding-flag">{rate.null_reason === null ? ` ${money(rate.numerator_vnd)} / ${money(rate.denominator_vnd)}` : ` ${t(`dis.funding.reason.${camel(rate.null_reason)}`)}`}</small>
    </span>
  );
}

export interface SinceStartTileProps {
  ratePct: string | null;
  nullReason: string | null;
  numerator: string | null;
  denominator: string | null;
  asOf: string;
  packCode: string;
  version: number;
  unverified: boolean;
}

/** The rate since the start of the project: the actual since the start over the total investment in force (the numerator and denominator are on the tile, the formula behind the "i"). */
export function SinceStartTile(props: SinceStartTileProps) {
  const { t } = useTranslation();
  return (
    <KpiTile
      label={t('dis.funding.figure.rateSinceStart')}
      value={percent(props.ratePct)}
      sub={
        <>
          {props.nullReason === null ? <span>{t('dis.funding.rate.sub', { numerator: money(props.numerator), denominator: money(props.denominator) })}</span> : <span data-testid="reason-RATE_SINCE_START">{t(`dis.funding.reason.${camel(props.nullReason)}`)}</span>}{' '}
          <FigureInfo
            code="RATE_SINCE_START"
            asOf={props.asOf}
            packCode={props.packCode}
            version={props.version}
            unverified={props.unverified}
            numeratorTerm="CUMULATIVE_SINCE_START"
            denominatorTerm="TMDT_IN_FORCE"
            source={t('dis.funding.basis.official')}
          />
        </>
      }
    />
  );
}

export const STATUS_TONES: Readonly<Record<SnapshotStatus, Tone>> = { BUILDING: 'info', FROZEN: 'success', SUPERSEDED: 'neutral', FAILED: 'danger' };

/** A link to the detail of a snapshot (DIS-33). */
export function SnapshotLink({ id, children }: { id: string; children: string }) {
  return <Link to={`${DETAIL_PATH}?snapshot=${id}`}>{children}</Link>;
}
