#!/usr/bin/env bun
/**
 * publish-check.ts — pre-publish gate (thin toolchain orchestrator).
 *
 * The shared mechanics are owned by @pellux/goodvibes-toolchain and driven by
 * this repo's toolchain.config.json:
 *   - sdk-pin-gate: the SDK-pin tri-agreement (overlay absent, exact-semver pin,
 *     installed==pin, lockfile resolves pin) + npm-specifier-only imports;
 *   - package-install-check: the tarball path/size policy + bin-shim
 *     (present/executable/shebang) check for this repo's single bin,
 *     goodvibes-daemon.
 * The checks that are genuinely repo-specific stay here as small local steps:
 *   - required publish-metadata fields on package.json;
 *   - a registry auth probe (npm whoami) before binaries/GH release are produced.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadToolchainConfig,
  realFsReader,
  runSdkPinGate,
  runPackageInstallCheck,
} from '@pellux/goodvibes-toolchain';

const root = process.cwd();
const config = loadToolchainConfig(root);
let failed = 0;

// 1) Shared SDK-pin tri-agreement + import sweep (toolchain).
for (const result of runSdkPinGate(realFsReader(root), config.sdkPin)) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id} — ${result.detail}`);
  if (!result.ok) failed += 1;
}

// 2) Repo-specific publish-metadata fields.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown> & {
  repository?: { url?: string };
  bin?: Record<string, string>;
};
for (const field of ['name', 'version', 'description', 'license']) {
  const value = pkg[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    console.error(`FAIL  publish-field-present — package.json missing required field: ${field}`);
    failed += 1;
  }
}
if (!pkg.repository || typeof pkg.repository.url !== 'string') {
  console.error('FAIL  publish-field-present — package.json missing repository metadata');
  failed += 1;
}
if (!pkg.bin || typeof pkg.bin['goodvibes-daemon'] !== 'string') {
  console.error('FAIL  publish-field-present — package.json must expose a goodvibes-daemon bin entry');
  failed += 1;
}

// 3) Shared tarball path/size policy + bin-shim check (toolchain).
if (config.publish) {
  const install = runPackageInstallCheck({
    cwd: root,
    config: config.publish,
    bins: [{ name: 'goodvibes-daemon', path: 'bin/goodvibes-daemon', shebang: '#!/usr/bin/env bun' }],
  });
  for (const issue of install.issues) console.error(`FAIL  package-install-check — ${issue}`);
  if (!install.ok) failed += 1;
}

// 4) Repo-specific registry auth probe. Skippable for offline/dry-run.
const registry = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim() || config.publish?.defaultRegistry || 'https://registry.npmjs.org';
const skipAuthCheck = process.env.GOODVIBES_SKIP_NPM_AUTH_CHECK === '1';
if (!skipAuthCheck) {
  try {
    execSync(`npm whoami --registry ${registry}`, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch {
    console.error(
      `FAIL  registry-auth — npm token invalid for ${registry} — refresh NPM_TOKEN / npm login\n` +
        '  (set GOODVIBES_SKIP_NPM_AUTH_CHECK=1 to bypass in offline/dry-run contexts)',
    );
    failed += 1;
  }
}

console.log(`publish-check: ${failed === 0 ? 'OK — all gates passed' : `${failed} gate(s) failed`}`);
process.exit(failed > 0 ? 1 : 0);
