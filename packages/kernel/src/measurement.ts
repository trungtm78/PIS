import { addDecimal, compareDecimal, roundDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The quantities of work done under a contract (ST-CTR-008, CTR 3.4, BR-CTR-03): a measurement is the quantity of one BOQ item done in one period, recorded by the contractor or the
 * supervisor, submitted, and approved by someone else. What has been approved never decreases without a correction, and what has been recorded (approved or still waiting) never goes
 * above the quantity of the item in the revision in force. Quantities are exact decimals with six digits after the point.
 */
export const MEASUREMENT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type MeasurementStatus = (typeof MEASUREMENT_STATUSES)[number];

/** The statuses whose quantity counts against the quantity of the item: a rejected measurement and a corrected one no longer do. */
export const LIVE_MEASUREMENT_STATUSES: readonly MeasurementStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED'];

export const QUANTITY_SCALE = 6;
const QUANTITY = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;

/** The commands of the life of a measurement and the statuses they take it from and to. */
export const MEASUREMENT_COMMANDS = ['submit', 'approve', 'reject', 'return', 'supersede'] as const;
export type MeasurementCommand = (typeof MEASUREMENT_COMMANDS)[number];

const TRANSITIONS: Readonly<Record<MeasurementCommand, { from: MeasurementStatus; to: MeasurementStatus }>> = {
  submit: { from: 'DRAFT', to: 'SUBMITTED' },
  approve: { from: 'SUBMITTED', to: 'APPROVED' },
  reject: { from: 'SUBMITTED', to: 'REJECTED' },
  return: { from: 'SUBMITTED', to: 'DRAFT' },
  supersede: { from: 'APPROVED', to: 'SUPERSEDED' },
};

export const measurementTarget = (command: MeasurementCommand, status: MeasurementStatus): MeasurementStatus | undefined => (TRANSITIONS[command].from === status ? TRANSITIONS[command].to : undefined);

/** 409 `MEASUREMENT_STATE_INVALID` unless the command applies to the status; the extensions say the status. */
export function assertMeasurementTransition(command: MeasurementCommand, status: MeasurementStatus, reason?: string): MeasurementStatus {
  const target = measurementTarget(command, status);
  if (target === undefined) throw new DomainError('MEASUREMENT_STATE_INVALID', 409, 'status', { extensions: { measurement_status: status, ...(reason === undefined ? {} : { reason }) } });
  return target;
}

/** The quantity written with exactly six digits after the point, as the database holds it; 422 `VALIDATION_FAILED` naming the field when it is not one. */
export function quantityOf(value: string, field: string): string {
  const text = value.trim();
  if (!QUANTITY.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return roundDecimal(text, QUANTITY_SCALE, 'DOWN');
}

/** What is left of the quantity of an item after what has been recorded, never below zero. */
export function remainingQuantity(boqQuantity: string, recorded: string): string {
  const left = subtractDecimal(boqQuantity, recorded);
  return roundDecimal(compareDecimal(left, '0') < 0 ? '0' : left, QUANTITY_SCALE, 'DOWN');
}

/**
 * 422 `QUANTITY_EXCEEDS_BOQ` when what has been recorded with `quantity` added goes above the quantity of the item; the extensions say what is left (`remaining_quantity`, six digits)
 * before this measurement, the quantity of the item and what the total would be.
 */
export function assertWithinBoq(boqQuantity: string, recorded: string, quantity: string): void {
  const total = addDecimal(recorded, quantity);
  if (compareDecimal(total, boqQuantity) > 0) {
    throw new DomainError('QUANTITY_EXCEEDS_BOQ', 422, 'quantity_period', {
      extensions: { remaining_quantity: remainingQuantity(boqQuantity, recorded), boq_quantity: roundDecimal(boqQuantity, QUANTITY_SCALE, 'DOWN'), total_quantity: roundDecimal(total, QUANTITY_SCALE, 'DOWN') },
    });
  }
}

/** 422 `CUMULATIVE_DECREASE_WITHOUT_CORRECTION`: a period that takes quantity away is not recorded, it is a correction of the measurement it changes. */
export function assertNotDecrease(quantity: string): void {
  if (compareDecimal(quantity, '0') < 0) throw new DomainError('CUMULATIVE_DECREASE_WITHOUT_CORRECTION', 422, 'quantity_period');
}

/** The cumulative quantity of an item once this measurement is approved: what was approved before, and this period. */
export const cumulativeQuantity = (approved: string, quantity: string): string => roundDecimal(addDecimal(approved, quantity), QUANTITY_SCALE, 'DOWN');
