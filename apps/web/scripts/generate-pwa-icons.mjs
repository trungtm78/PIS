// Launcher: Node strips the TypeScript types of the module it imports, so the generator runs without a build step.
import { main } from '../src/pwa/icons-cli.ts';

process.exitCode = main(process.argv.slice(2));
