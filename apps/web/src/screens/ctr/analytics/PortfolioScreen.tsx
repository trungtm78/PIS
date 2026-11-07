import type { ScreenProps } from '../../../routes/types';
import { ReportPage } from './ReportPage';

/** CTR-29: the portfolio and the status of the contracts (R2), read from the server with its own filters, sort, pages and totals. */
export default function PortfolioScreen({ route }: ScreenProps) {
  return <ReportPage route={route} code="portfolio-status" />;
}
