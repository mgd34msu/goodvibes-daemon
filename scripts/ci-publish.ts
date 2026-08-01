/**
 * Publish this package to npmjs from CI, idempotently, with nothing hidden.
 *
 * Order of operations:
 *   1. If the registry already serves exactly this name@version, succeed.
 *   2. Otherwise `npm publish` with output streamed straight through — no
 *      capture buffer, so a refusal arrives whole in the job log.
 *   3. If publish failed, ask the registry once more: a race with a publish
 *      that landed through another path (or read-path lag clearing mid-run)
 *      still counts as published. Only a version the registry does not serve
 *      after all three steps fails the job.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGISTRY = process.env['GOODVIBES_PUBLISH_REGISTRY'] ?? 'https://registry.npmjs.org';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { name: string; version: string };
const spec = `${pkg.name}@${pkg.version}`;

function servedVersion(): string | null {
  const res = spawnSync('npm', ['view', spec, 'version', '--registry', REGISTRY], { encoding: 'utf-8' });
  const out = (res.stdout ?? '').trim();
  return res.status === 0 && out.length > 0 ? out : null;
}

if (servedVersion() === pkg.version) {
  console.log(`[ci-publish] ${spec} already on ${REGISTRY} — nothing to do`);
  process.exit(0);
}

console.log(`[ci-publish] publishing ${spec} to ${REGISTRY}`);
const pub = spawnSync('npm', ['publish', '--access', 'public', '--registry', REGISTRY], { stdio: 'inherit' });

if (pub.status === 0) {
  console.log(`[ci-publish] published ${spec}`);
  process.exit(0);
}

const after = servedVersion();
if (after === pkg.version) {
  console.log(`[ci-publish] publish exited ${pub.status} but ${spec} is served — treating as published`);
  process.exit(0);
}

console.error(`[ci-publish] FAILED: ${spec} is not on ${REGISTRY} (publish exit ${pub.status}); the refusal is printed above in full`);
process.exit(1);
