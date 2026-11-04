import { journalFetch } from './uat-journal';

// Loaded by the Jest config of the api only when a UAT run is on (UAT_JOURNAL names the journal file).
journalFetch();
