import { defineModule } from '../module-descriptor';
import { IndEntryController } from './entry.controller';
import { IndImportController } from './import.controller';
import { IndReadsController } from './reads.controller';

/**
 * IND, indicators and data entry (IND-1, customer dossier DL.02): the indicator dictionary (a KPI definition with the members that say how a figure is obtained and entered), the entry rules that hold a number
 * to the identities of the data at the moment it is typed or loaded (cumulative not above the total, parts equal to the total, a closed period, required fields, plausible ranges), the figures entered against the
 * dictionary (append-only, a correction is the next revision with its reason) and the import of the customer's Excel forms through mappings that have versions and an approver. Definitions are drafted, submitted and
 * approved through the governance rules (a maker is not the checker); this module reads them and holds entries to them.
 */
export const indModule = defineModule({
  code: 'IND',
  controllers: [IndReadsController, IndEntryController, IndImportController],
});
