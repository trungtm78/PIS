import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where the API stack describes itself by default (and where its pid and stop files live). */
const DEFAULT_STACK_INFO_PATH = resolve(HERE, '..', '.stack', 'stack-info.json');
/**
 * E2E_STACK_INFO names the info file of one particular stack (the stack runner reads the same variable), so that several stacks can live side by side:
 * the seeds, the helpers and the cleanup of that stack all follow it. Without it the default path in e2e/.stack is used.
 */
const overridden = process.env.E2E_STACK_INFO;
export const STACK_INFO_PATH = overridden !== undefined && overridden !== '' ? (isAbsolute(overridden) ? overridden : resolve(process.cwd(), overridden)) : DEFAULT_STACK_INFO_PATH;
/** The directory of the stack's files. */
export const STACK_DIR = dirname(STACK_INFO_PATH);
export const STACK_STOP_PATH = `${STACK_INFO_PATH}.stop`;
export const STACK_PID_PATH = `${STACK_INFO_PATH}.pid`;
/** The temporary directory prefix of the stack's database (apps/api/test/e2e-stack): its leftovers are recognised by it. */
export const STACK_TEMP_PREFIX = 'machvon-e2e-pg-';
