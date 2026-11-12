import { AS_OF, PROJECT_ID, band, uuid } from '../../test/fixtures';
import type { BandPreview } from '../../model';
import type { MyTask, MyTaskPage, PreferenceBody } from '../model';

export { AS_OF, uuid };

/** The answer of `getDeadlinePreference`: by default nothing set, the official ladder 5/2/0, version 0. */
export const preferenceBody = (over: Partial<PreferenceBody> = {}): PreferenceBody => ({
  green_days: null,
  yellow_days: null,
  red_days: null,
  reminder_days: [],
  official: { green_days: 5, yellow_days: 2, red_days: 0 },
  clamped: [],
  version: 0,
  as_of: AS_OF,
  ...over,
});

/** A person who set the ladder 7/3/1 and the reminders 7, 3, 1 (saved once, version 3). */
export const savedBody = (over: Partial<PreferenceBody> = {}): PreferenceBody => preferenceBody({ green_days: 7, yellow_days: 3, red_days: 1, reminder_days: [7, 3, 1], version: 3, ...over });

/** What the server says about the personal ladder 7/3/1: the same as the colours computed on the device. */
export const personalPreview = (over: Partial<BandPreview> = {}): BandPreview => ({
  unit: 'WORKING',
  thresholds: { green_days: 7, yellow_days: 3, red_days: 1 },
  examples: [
    { remaining_days: 8, band: 'NONE' },
    { remaining_days: 7, band: 'GREEN' },
    { remaining_days: 4, band: 'GREEN' },
    { remaining_days: 3, band: 'YELLOW' },
    { remaining_days: 2, band: 'YELLOW' },
    { remaining_days: 1, band: 'RED' },
    { remaining_days: 0, band: 'RED' },
  ],
  as_of: AS_OF,
  ...over,
});

export const myTask = (n: number, over: Partial<MyTask> = {}): MyTask => ({
  task_id: uuid(1000 + n),
  task_code: `T${n}`,
  name: `Công việc của tôi ${n}`,
  project_id: PROJECT_ID,
  project_code: 'DA-001',
  status: 'IN_PROGRESS',
  due_date: '2026-12-10',
  official_band: band('GREEN', { remaining_days: 3 }),
  personal_band: null,
  critical: false,
  version: 1,
  ...over,
});

export const myTasks = (items: MyTask[] = [myTask(1), myTask(2, { official_band: band('GREEN', { remaining_days: 3 }), personal_band: band('YELLOW', { remaining_days: 3 }) })], over: Partial<MyTaskPage> = {}): MyTaskPage => ({
  items,
  next_cursor: null,
  total: items.length,
  as_of: AS_OF,
  ...over,
});
