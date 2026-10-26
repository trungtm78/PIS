import { asSuperuser } from './ncr-fixtures';

/**
 * A contract that was completed, as the completion of ST-CTR-011 leaves it: the day, the acceptance it rests on and the person who completed it are all kept (`contract_completion_chk`). The write goes
 * in as the owner of the database with the triggers and the foreign keys off, so that a test that only needs a contract that is over does not have to build the acceptance behind it.
 */
export const completeContract = (adminUrl: string, contractId: string, completedBy: string): Promise<void> =>
  asSuperuser(
    adminUrl,
    "update machvon.contract set status = 'COMPLETED', completed_on = date '2027-08-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $2::uuid where id = $1::uuid",
    [contractId, completedBy],
  );
