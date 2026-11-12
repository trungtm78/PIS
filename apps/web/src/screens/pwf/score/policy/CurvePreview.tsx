import { useTranslation } from '../../../../i18n';
import { curveOf } from './kpi-set-model';
import type { ScaleForm } from './kpi-set-model';

const WIDTH = 240;
const HEIGHT = 100;

/** The conversion of a value to a score as a picture and, next to it, as a list of the same points in words (the picture is never the only way to read it). */
export function CurvePreview({ scale }: { scale: ScaleForm }) {
  const { t } = useTranslation();
  const points = curveOf(scale);
  if (points.length === 0) {
    return (
      <p className="adm-kit-sub" data-testid="curve-blocked">
        {t('pwfs.kpiset.curve.blocked.text')}
      </p>
    );
  }
  const low = Math.min(...points.map((point) => point.value));
  const high = Math.max(...points.map((point) => point.value));
  const x = (value: number): number => (high === low ? WIDTH / 2 : ((value - low) / (high - low)) * WIDTH);
  const y = (score: number): number => HEIGHT - (score / 100) * HEIGHT;
  const line = points.map((point) => `${x(point.value).toFixed(1)},${y(point.score).toFixed(1)}`).join(' ');
  return (
    <div data-testid="curve">
      <svg className="pwfs-curve" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('pwfs.kpiset.curve.label', { from: low, to: high })}>
        <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="none" stroke="currentColor" strokeOpacity="0.3" />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <ol className="pwfs-list-inline" data-testid="curve-points">
        {points.map((point) => (
          <li key={point.value}>{t('pwfs.kpiset.curve.point.text', { value: point.value, score: point.score })}</li>
        ))}
      </ol>
    </div>
  );
}
