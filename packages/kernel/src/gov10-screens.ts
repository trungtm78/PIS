/**
 * The ids of the screens that lane GOV-10 adds (the catalogue `screen_catalog.json` gives the next free id of a module, so two lanes that add at the same time may pick the same one: the lead renumbers here, in the
 * routes and in the catalogue rows, and nowhere else, because every other place reads these constants).
 */
export const GOV10_SCREENS = {
  redFlagList: 'AUD-14',
  redFlagDetail: 'AUD-15',
  redFlagRegistry: 'AUD-16',
  ladder: 'NOT-30',
  alertFeedbackQueue: 'HOME-30',
  alertClosures: 'HOME-31',
} as const;
