import type { ScreenProps } from '../../../routes/types';
import { ReportPage } from './ReportPage';

/** CTR-30: the difference between the price a package was won at and the price the contract was signed at (R1). */
export default function BidVarianceScreen({ route }: ScreenProps) {
  return <ReportPage route={route} code="bid-variance" />;
}
