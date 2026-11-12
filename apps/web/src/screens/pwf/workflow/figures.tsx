import { useTranslation } from '../../../i18n';
import { FigureInfo } from '../components';

export type Figure = 'bands' | 'critical' | 'finish' | 'variance' | 'count' | 'gate' | 'phase' | 'float';

interface Props {
  figure: Figure;
  /** The `as_of` of the answer the figure comes from. */
  asOf: string;
  /** The version of the schedule or of the template behind the figure, already translated. */
  version: string;
}

/** The "i" of one figure of the workflow: what it is, how it is computed and where its inputs come from (the rule of the module: no number without it). */
export function WorkflowInfo({ figure, asOf, version }: Props) {
  const { t } = useTranslation();
  const words = (() => {
    switch (figure) {
      case 'bands':
        return { name: t('pwf.flow.info.bands.name'), formula: t('pwf.flow.info.bands.formula'), source: t('pwf.flow.info.bands.source') };
      case 'critical':
        return { name: t('pwf.flow.info.critical.name'), formula: t('pwf.flow.info.critical.formula'), source: t('pwf.flow.info.critical.source') };
      case 'finish':
        return { name: t('pwf.flow.info.finish.name'), formula: t('pwf.flow.info.finish.formula'), source: t('pwf.flow.info.finish.source') };
      case 'variance':
        return { name: t('pwf.flow.info.variance.name'), formula: t('pwf.flow.info.variance.formula'), source: t('pwf.flow.info.variance.source') };
      case 'count':
        return { name: t('pwf.flow.info.count.name'), formula: t('pwf.flow.info.count.formula'), source: t('pwf.flow.info.count.source') };
      case 'gate':
        return { name: t('pwf.flow.info.gate.name'), formula: t('pwf.flow.info.gate.formula'), source: t('pwf.flow.info.gate.source') };
      case 'phase':
        return { name: t('pwf.flow.info.phase.name'), formula: t('pwf.flow.info.phase.formula'), source: t('pwf.flow.info.phase.source') };
      case 'float':
        return { name: t('pwf.flow.info.float.name'), formula: t('pwf.flow.info.float.formula'), source: t('pwf.flow.info.float.source') };
    }
  })();
  return <FigureInfo name={words.name} formula={words.formula} source={words.source} asOf={asOf} version={version} />;
}
