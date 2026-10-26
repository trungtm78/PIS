import { DomainError } from './errors.ts';

/**
 * The inventory of the assets of an affected household (LND BR-LND-04): what is counted, and how a count becomes an amount. The amount of a record is the quantity times the unit
 * price, rounded half up to the dong; it is computed on whole numbers (a quantity has at most six decimals, a price is whole dong), so that no float ever touches money.
 */

export const INVENTORY_ITEM_KINDS = ['LAND', 'HOUSE', 'STRUCTURE', 'CROP', 'TREE', 'GRAVE', 'BUSINESS_LOSS', 'OTHER'] as const;
export type InventoryItemKind = (typeof INVENTORY_ITEM_KINDS)[number];

/** The ways a record can end up: waiting for the household, accepted by it, objected to by it, or replaced by a newer count. */
export const INVENTORY_STATUSES = ['DRAFT', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

/** How many decimals of a quantity are kept (numeric(24,6)). */
export const QUANTITY_SCALE = 6;
const QUANTITY = /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/;
const PRICE = /^(0|[1-9]\d{0,23})$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A quantity as the table keeps it: greater than zero, at most six decimals; a refusal otherwise (422 `VALIDATION_FAILED`, `quantity`). */
export function normalizeQuantity(value: string): string {
  const quantity = value.trim();
  if (!QUANTITY.test(quantity) || /^0(\.0+)?$/.test(quantity)) throw invalid('quantity');
  return quantity;
}

/** A unit price in whole dong, zero or more (422 `VALIDATION_FAILED`, `unit_price_vnd`). */
export function normalizeUnitPrice(value: string): string {
  const price = value.trim();
  if (!PRICE.test(price)) throw invalid('unit_price_vnd');
  return price;
}

/** `quantity × unit price` rounded half up to the dong, as a decimal string of whole dong (BR-LND-04: 80 m2 × 4.500.000 = 360.000.000). */
export function inventoryAmountVnd(quantity: string, unitPriceVnd: string): string {
  const [whole = '0', fraction = ''] = normalizeQuantity(quantity).split('.');
  const scaled = BigInt(whole + fraction.padEnd(QUANTITY_SCALE, '0'));
  const unit = 10n ** BigInt(QUANTITY_SCALE);
  const product = scaled * BigInt(normalizeUnitPrice(unitPriceVnd));
  return ((product + unit / 2n) / unit).toString();
}
