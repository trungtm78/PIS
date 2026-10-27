import type { ScreenProps } from '../../routes/types';
import { CenterView } from './CenterView';

/** HOME-01: the executive overview (ST-HOME-001): the same figures of the same snapshot as the command center, with the unit and the day they are as of. */
export default function OverviewScreen({ route }: ScreenProps) {
  return <CenterView route={route} variant="overview" />;
}
