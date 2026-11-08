#!/usr/bin/env node
// The edge collector of the feed of the Finance Department: reads the export of the Finance application (a drop folder or an API), checks it against the layout the platform reads, keeps every batch in an offline
// spool, and pushes it to the platform (channel API_PUSH) with a machine account, once per batch hash. Node 20 or later, ES modules, no native dependency: it runs on linux arm64 and amd64, windows x64 and arm64,
// macOS arm64. Usage:
//   node feed-collector.mjs --config collector.json          run until stopped (SIGINT, SIGTERM)
//   node feed-collector.mjs --config collector.json --once   one pass, then exit (for a scheduler)
//   node feed-collector.mjs --check [--config collector.json] print the platform and check the configuration
import { runOnce } from './agent.mjs';
import { createClient } from './client.mjs';
import { credentialsOf, loadConfig } from './config.mjs';
import { platformInfo } from './platform.mjs';

const argumentsOf = (argv) => {
  const found = { config: undefined, once: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--config') {
      found.config = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--once') found.once = true;
    else if (argv[index] === '--check') found.check = true;
  }
  return found;
};

const log = (event, data) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const info = platformInfo();
  if (options.check) {
    log('platform', info);
    if (options.config !== undefined) {
      const config = await loadConfig(options.config);
      await credentialsOf(config);
      log('configuration', { source: config.source.type, layout_version: config.layoutVersion, state_dir: config.stateDir, interval_seconds: config.intervalSeconds });
    }
    process.exitCode = info.supported ? 0 : 1;
    return;
  }
  if (options.config === undefined) throw new Error('--config <file> is required');
  if (!info.node_ok) throw new Error(`Node ${info.node} is too old: Node 20 or later is required`);
  const config = await loadConfig(options.config);
  const { clientId, clientSecret } = await credentialsOf(config);
  const client = createClient({ baseUrl: config.platform.baseUrl, tokenUrl: config.platform.tokenUrl, clientId, clientSecret });
  log('start', { platform: info, source: config.source.type, once: options.once });
  const pass = () => runOnce({ config, client, log });
  if (options.once) {
    await pass();
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pass();
    } catch (error) {
      log('error', { message: String(error.message ?? error) });
    } finally {
      running = false;
    }
  };
  await tick();
  const timer = setInterval(tick, config.intervalSeconds * 1000);
  const stop = () => {
    clearInterval(timer);
    log('stop', {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(String(error.message ?? error));
  process.exitCode = 2;
});
