/**
 * The public holidays of a year as the Labour Code names them, kept as DATA so that the preset button of ADM-07 ("Nạp ngày lễ theo thông báo của năm") never calls anything on the network.
 *
 * SOURCE: Bộ luật Lao động 2019, Điều 112 khoản 1 (Tết Dương lịch 1 ngày; Tết Âm lịch 5 ngày; Ngày Chiến thắng 1 ngày; Ngày Quốc tế lao động 1 ngày; Quốc khánh 2 ngày, là ngày 2/9 và 1 ngày liền kề trước hoặc sau; Giỗ Tổ Hùng Vương
 * 1 ngày, 10/3 âm lịch) and khoản 2 (a holiday on a weekly rest day is made up on the next working day). The exact days of each year are the ones the annual notice of the Prime Minister or the Ministry of Home Affairs fixes.
 *
 * NOT VERIFIED (`VERIFIED` is false): nobody of the legal office has compared this table with the notices (ledger item CXN-CAL-01 awaits confirmation). The preset fills a DRAFT the person edits, and the draft says so in its legal
 * basis. Change `VERIFIED` and `LUNAR_DAYS` only with the notice of the year in hand.
 */
export const VERIFIED = false;

/** The legal basis the preset writes into a draft; it states the catalogue is not verified, so that nobody confirms a year on it unread. */
export const SOURCE_NAME = 'Bộ luật Lao động 2019, Điều 112';

export interface HolidayRule {
  /** Stable id of the holiday in this catalogue. */
  id: string;
  name: string;
  /** The days after (positive) or before (negative) the anchor day that are off; 0 is the anchor day itself. */
  offsets: readonly number[];
}

/** Holidays of a fixed day in the solar calendar: the anchor is month and day of every year. */
export const SOLAR_HOLIDAYS: ReadonlyArray<HolidayRule & { month: number; day: number }> = [
  { id: 'NEW_YEAR', name: 'Tết Dương lịch', month: 1, day: 1, offsets: [0] },
  { id: 'VICTORY', name: 'Ngày Chiến thắng 30/4', month: 4, day: 30, offsets: [0] },
  { id: 'LABOUR', name: 'Ngày Quốc tế lao động', month: 5, day: 1, offsets: [0] },
  // The second day is "1 ngày liền kề trước hoặc sau": the draft takes the day before; the notice of the year says which, and the person moves it.
  { id: 'NATIONAL', name: 'Quốc khánh', month: 9, day: 2, offsets: [-1, 0] },
];

/** Holidays counted in the lunar calendar: the anchor is the solar day of the lunar day in each year known to the catalogue. */
export const LUNAR_HOLIDAYS: ReadonlyArray<HolidayRule & { anchor: 'TET' | 'HUNG_KINGS' }> = [
  // One day at the end of the lunar year and the first four of the new one.
  { id: 'TET', name: 'Tết Nguyên đán', anchor: 'TET', offsets: [-1, 0, 1, 2, 3] },
  { id: 'HUNG_KINGS', name: 'Giỗ Tổ Hùng Vương', anchor: 'HUNG_KINGS', offsets: [0] },
];

/** Solar day of the first of the lunar new year (TET) and of 10/3 of the lunar calendar (HUNG_KINGS), by year; a year not listed has no lunar holiday in the preset. */
export const LUNAR_DAYS: Readonly<Record<number, { TET: string; HUNG_KINGS: string }>> = {
  2025: { TET: '2025-01-29', HUNG_KINGS: '2025-04-07' },
  2026: { TET: '2026-02-17', HUNG_KINGS: '2026-04-26' },
  2027: { TET: '2027-02-06', HUNG_KINGS: '2027-04-16' },
  2028: { TET: '2028-01-26', HUNG_KINGS: '2028-04-04' },
};

/** The name a day gets when it is the make-up day of a holiday that fell on a weekly rest day (Điều 112 khoản 2). */
export const MAKE_UP_NAME = 'Nghỉ bù';
