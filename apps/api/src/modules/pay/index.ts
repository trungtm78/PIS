import { defineModule } from '../module-descriptor';
import { AdvanceController, AdvanceReadsController } from './advance.controller';
import { CumulativeLedgerController } from './cumulative-ledger.controller';
import { PaymentFormController } from './payment-form.controller';
import { PaymentReversalController } from './payment-reversal.controller';
import { PaymentClaimController } from './payment-claim.controller';
import { PaymentRequestController, PaymentRequestReadsController } from './payment-request.controller';
import { ReconciliationController, ReconciliationReadsController } from './reconciliation.controller';
import { TreasuryMatchController } from './settlement.controller';
import { TreasuryImportController, TreasuryImportReadsController } from './treasury-import.controller';
import { TreasuryTransactionController, TreasuryTransactionReadsController } from './treasury-transaction.controller';

/**
 * PAY, payments and the Treasury. This slice carries the Treasury statement file import, idempotent by the SHA-256 of the file and the
 * business key of each row, with the quarantine and the differences that have an owner; the confirmation of a payment by hand with evidence;
 * the callback of the Treasury (adapter MOCK, API MISSING); and the read model of the transactions (ST-PAY-006). The cumulative ledger of a contract is kept by the consumer of the acceptance events and read by CumulativeLedgerController (ST-PAY-001). The draft of a payment request, with its documents, is PaymentRequestController (ST-PAY-002); sending it, checking it and giving it back is PaymentClaimController (ST-PAY-003). The advance of a contract, its cap and its recovery are AdvanceController and AdvanceReadsController (ST-PAY-004). The Treasury forms of a checked request and the record that the file was sent are PaymentFormController (ST-PAY-005). Matching a Treasury transaction to a payment, which settles it or opens a difference, is TreasuryMatchController, and the work on a difference and the tracking of the projects are ReconciliationController and ReconciliationReadsController (ST-PAY-007). Reversing a payment that was settled, against the refund the Treasury confirmed, is PaymentReversalController (ST-PAY-008). The adapter of the
 * statement is PROPOSED: its layout is a working assumption until the agency gives anonymised samples (docs/pay-treasury-import.md).
 */
export const payModule = defineModule({
  code: 'PAY',
  controllers: [TreasuryImportController, TreasuryImportReadsController, TreasuryTransactionController, TreasuryTransactionReadsController, CumulativeLedgerController, PaymentRequestController, PaymentClaimController, PaymentFormController, PaymentRequestReadsController, AdvanceController, AdvanceReadsController, TreasuryMatchController, ReconciliationController, ReconciliationReadsController, PaymentReversalController],
});
