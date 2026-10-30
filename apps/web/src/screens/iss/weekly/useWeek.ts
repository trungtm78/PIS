import { useSearchParams } from 'react-router-dom';
import { isoWeekOf, vietnamDay } from './model';

/** The week and the unit of the screen, read from and written to its address; without a week it is the week of today. */
export function useWeek(): { week: string; unitId: string; set(next: { week: string; unitId: string }): void } {
  const [search, setSearch] = useSearchParams();
  const week = search.get('week') ?? isoWeekOf(vietnamDay(new Date()));
  const unitId = search.get('unit') ?? '';
  return {
    week,
    unitId,
    set(next) {
      const params = new URLSearchParams();
      params.set('week', next.week);
      if (next.unitId !== '') params.set('unit', next.unitId);
      setSearch(params, { replace: true });
    },
  };
}

