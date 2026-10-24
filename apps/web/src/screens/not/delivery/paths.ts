import { routeById } from '../../../routes/registry';

const JOURNEY_ROUTE = 'NOT-12';

/** The path of the journey of one attempt (NOT-12). */
export function journeyPathOf(id: string): string {
  return `${routeById(JOURNEY_ROUTE)?.path ?? '/not/not-12'}?id=${encodeURIComponent(id)}`;
}
