import type { ScreenProps } from '../../routes/types';
import { CenterView } from './CenterView';

/** HOME-09: the command center of the disbursement (ST-HOME-001): the two rates side by side, the amounts, what waits, and the context of every figure above them. */
export default function CommandCenterScreen({ route }: ScreenProps) {
  return <CenterView route={route} variant="command" />;
}
