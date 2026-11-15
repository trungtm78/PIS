import { ConfigError, DEMO_SINGLE_FACTOR_WARNING, loadConfig } from './config/config';
import { bootstrap } from './bootstrap';

const EXIT_CONFIG = 78;

/**
 * The process entry (`npm start`): validates the environment, starts the API and stops it gracefully on SIGTERM or SIGINT.
 * A bad environment is reported by variable name (never by value) and ends the process with status 78 before any
 * connection is opened.
 */
export async function run(env: Record<string, string | undefined> = process.env): Promise<number> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return EXIT_CONFIG;
  }
  if (config.demoSingleFactor) process.stderr.write(`${DEMO_SINGLE_FACTOR_WARNING}
`);
  const api = await bootstrap(config);
  process.stdout.write(`machvon-api listening on port ${api.port}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void api.stop().finally(resolve);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  return 0;
}

if (process.argv[1] !== undefined && /serve\.ts$/.test(process.argv[1])) {
  run().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`machvon-api failed to start: ${error instanceof Error ? error.name : 'UnknownError'}\n`);
      process.exit(1);
    },
  );
}
