import { isCancel, select, text } from '@clack/prompts';
import { exec, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';

import { showCancel, showIntro, showOutro } from '../utils/banners.js';
import * as log from '../utils/logger.js';

import type { PublishOptions } from '../types.js';

const execAsync = promisify(exec);

function handleCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    showCancel('Operation cancelled');
    process.exit(0);
  }
  return value as T;
}

function validateBundle(): boolean {
  try {
    const bundlePath = resolve(process.cwd(), 'bundle');
    const packagePath = resolve(bundlePath, 'package.json');
    const bundleZipPath = resolve(bundlePath, 'bundle.zip');

    try {
      readFileSync(packagePath);
    } catch {
      log.error('package.json not found in bundle. Please run "npm run bundle" first.');
      return false;
    }

    try {
      readFileSync(bundleZipPath);
    } catch {
      log.error('bundle.zip not found. Please run "npm run bundle" first.');
      return false;
    }

    return true;
  } catch (error) {
    log.error(`Validation failed: ${(error as Error).message}`);
    return false;
  }
}

async function validateVersion(name: string, version: string): Promise<boolean> {
  if (!semver.valid(version)) {
    log.error('Invalid version format. Please use semver (e.g. 1.0.0)');
    return false;
  }

  try {
    const { stdout } = await execAsync(`npm view ${name} versions --json`);
    const versions = JSON.parse(stdout);

    if (versions.includes(version)) {
      log.error(`Version ${version} already exists`);
      return false;
    }

    return true;
  } catch {
    return true;
  }
}

async function spawnPromise(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

export async function publishProject(options: PublishOptions) {
  showIntro();

  if (!options.alpha && !options.beta && !options.latest) {
    log.error('Please specify a version to publish: --alpha, --beta, --latest');
    process.exit(1);
  }

  if (!validateBundle()) {
    process.exit(1);
  }

  const pJsonPath = resolve(process.cwd(), 'bundle', 'package.json');
  const pJson = JSON.parse(readFileSync(pJsonPath, 'utf-8'));
  const { name, version } = pJson;
  const tag = options.alpha ? 'alpha' : options.beta ? 'beta' : options.latest ? 'latest' : 'latest';

  // Non-interactive mode (CI): publish exactly the version baked into
  // bundle/package.json — no prompts. The version is the single source of
  // truth (set by the release tag), so there's nothing to confirm.
  const targetVersion = options.yes
    ? version
    : handleCancel(
        await text({
          message: 'Version:',
          placeholder: version,
          defaultValue: version,
          validate: (value) => {
            if (!semver.valid(value)) {
              return 'Invalid version format. Please use semver (e.g. 1.0.0)';
            }
            return undefined;
          },
        }),
      );

  if (!semver.valid(targetVersion)) {
    log.error(`Invalid version in bundle/package.json: ${targetVersion}`);
    process.exit(1);
  }

  // Validate version doesn't already exist
  const versionValid = await validateVersion(name, targetVersion);
  if (!versionValid) {
    process.exit(1);
  }

  const action = options.yes
    ? 'publish'
    : handleCancel(
        await select({
          message: `Publishing ${name}@${targetVersion} (${tag}). Pick an action:`,
          options: [
            { value: 'publish', label: 'Publish' },
            { value: 'cancel', label: 'Cancel' },
          ],
        }),
      );

  if (action === 'cancel') {
    showCancel('Operation cancelled');
    process.exit(0);
  }

  if (action === 'publish') {
    try {
      log.info('Updating package version...');
      pJson.version = targetVersion;

      // `--access public` is required for the first publish of a scoped
      // package and harmless afterwards, so it's always passed. `--provenance`
      // additionally emits an OIDC-signed provenance attestation (CI only).
      const extraArgs = ['--access', 'public', ...(options.provenance ? ['--provenance'] : [])];

      // Publish platform packages first
      const platformsDir = resolve(process.cwd(), 'bundle', 'platforms');
      if (existsSync(platformsDir)) {
        const platformDirs = readdirSync(platformsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        if (platformDirs.length > 0) {
          log.info('Publishing platform packages...');

          for (const dir of platformDirs) {
            const platformDir = resolve(platformsDir, dir);
            const platformPkgPath = resolve(platformDir, 'package.json');
            const platformPkgContent = await readFile(platformPkgPath, 'utf-8');
            const platformPkg = JSON.parse(platformPkgContent);

            // Update version to match target version
            platformPkg.version = targetVersion;
            await writeFile(platformPkgPath, JSON.stringify(platformPkg, null, 2));

            log.info(`  Publishing ${platformPkg.name}@${targetVersion}...`);
            process.env.SAFE_PUBLISH = 'true';
            await spawnPromise('npm', ['publish', '--tag', tag, ...extraArgs], platformDir);
            log.success(`  Published ${platformPkg.name}@${targetVersion}`);
          }

          // Update optionalDependencies versions in main package
          if (pJson.optionalDependencies) {
            for (const dep of Object.keys(pJson.optionalDependencies)) {
              pJson.optionalDependencies[dep] = targetVersion;
            }
          }
        }
      }

      await writeFile(pJsonPath, JSON.stringify(pJson, null, 2));

      log.info('Publishing to npm...');

      process.env.SAFE_PUBLISH = 'true';

      const args = ['publish', '--tag', tag, ...extraArgs];
      await spawnPromise('npm', args, resolve(process.cwd(), 'bundle'));

      showOutro(`Successfully published ${name}@${targetVersion}`);
    } catch (error) {
      log.error('Failed to publish package');
      log.error((error as Error).message);
      process.exit(1);
    }
  }
}
