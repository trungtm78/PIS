import { ReportCatalogueStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { REPORT_FORM_CATALOGUE, assertReceiverKnown, reportCatalogueView } from '@machvon/kernel';
import type { CatalogueForm } from '@machvon/kernel';

/**
 * The receivers and the receiver of a form from the managed report catalogue (MD.03): the entries of `REPORT_TYPE` and `RECEIVING_AGENCY` that the tenant has in force, over the forms that the code owns. A tenant that
 * keeps none of them gets exactly what the code gave before. Only the forms of the code are judged here; a layout the tenant configured without code (and the forms of the public edition) carries its own receiver.
 */
const catalogue = new ReportCatalogueStore();
const OWNED_CODES: ReadonlySet<string> = new Set(REPORT_FORM_CATALOGUE.map((form) => form.code));

export const isCatalogueForm = (layoutCode: string): boolean => OWNED_CODES.has(layoutCode);

/** The form as the catalogue of the tenant sees it today, or undefined for a layout the catalogue does not own. */
export async function catalogueFormOf(tx: TenantTx, layoutCode: string, today: string): Promise<CatalogueForm | undefined> {
  if (!isCatalogueForm(layoutCode)) return undefined;
  return reportCatalogueView(await catalogue.read(tx, today), REPORT_FORM_CATALOGUE).forms.find((form) => form.code === layoutCode);
}

/** A delivery or an answer of a form of the code names a receiver the tenant's catalogue knows (422 `VALIDATION_FAILED`, `receiver`); other layouts are not judged. */
export async function assertCatalogueReceiver(tx: TenantTx, layoutCode: string, receiver: string, today: string): Promise<void> {
  if (!isCatalogueForm(layoutCode)) return;
  assertReceiverKnown(reportCatalogueView(await catalogue.read(tx, today), REPORT_FORM_CATALOGUE), receiver);
}
