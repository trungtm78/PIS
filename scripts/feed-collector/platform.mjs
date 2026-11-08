import os from 'node:os';

/** The systems the collector is built and tested for: it has no native dependency, so it runs on any of them that has Node 20 or later. */
export const SUPPORTED = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
];
export const MINIMUM_NODE_MAJOR = 20;

/** What this machine is, for the heartbeat and the log (the platform learns on which hardware the collector runs). */
export function platformInfo(runtime = { platform: process.platform, arch: process.arch, version: process.versions.node, hostname: os.hostname(), cpus: os.cpus().length }) {
  const major = Number(String(runtime.version).split('.')[0]);
  const listed = SUPPORTED.some((entry) => entry.platform === runtime.platform && entry.arch === runtime.arch);
  return { os: runtime.platform, arch: runtime.arch, node: runtime.version, hostname: runtime.hostname, cpus: runtime.cpus, supported: listed && major >= MINIMUM_NODE_MAJOR, node_ok: major >= MINIMUM_NODE_MAJOR };
}
