/**
 * The ids of the screens that lane GOV-12 adds, taken as the next free number of each module after reading the catalogue of every lane tip (PRJ stood at 29 on the tip of GOV-11a, AUD at 16 on GOV-10, DOC at 27 on
 * DOC-2, QMS at 11, RPT at 4). If another lane took the same number, the lead renumbers here, in the routes and in the catalogue rows, and nowhere else: every other place reads these constants.
 */
export const GOV12_SCREENS = {
  mofForms: 'RPT-05',
  periodLocks: 'RPT-06',
  monitoringList: 'PRJ-31',
  monitoringDetail: 'PRJ-32',
  portalAdmin: 'PRJ-33',
  portalPublic: 'PRJ-34',
  investorStanding: 'AUD-17',
  whistleInbox: 'AUD-18',
  giftRegister: 'AUD-19',
  transmittalList: 'DOC-28',
  transmittalDetail: 'DOC-29',
  photoFindings: 'QMS-12',
} as const;
