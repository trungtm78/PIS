// The restore drill of the whole cluster: node scripts/restore-drill.mjs measure|compare ... (docs/runbooks/infra/restore-drill.md).
// It is the entry of packages/db/src/restore-drill-cli.ts, which reuses the tenant restore tooling (TenantRestoreStore.measure, verifyRestore).
import { main } from '../packages/db/src/restore-drill-cli.ts';

process.exitCode = await main(process.argv.slice(2));
