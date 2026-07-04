import { getContractValidationErrors, validateContractConsistency } from '@camera.ui/sdk';
import AdmZip from 'adm-zip';
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isPlatformPackageNode, isPlatformPackagePython, PLATFORM_PACKAGES_NODE } from '../platform-packages.js';
import { showIntro, showOutro } from '../utils/banners.js';
import * as log from '../utils/logger.js';
import { parseConfig } from '../utils/parser.js';
import { copyPath, detectLanguage, ensureDir, findFile } from '../utils/utils.js';

import type { GoBuildOptions, GoTarget, PluginLanguage } from '../types.js';
import type { RequiredFile } from '../utils/utils.js';

const DEFAULT_GO_TARGETS: GoTarget[] = [
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'linux', goarch: 'arm64' },
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'arm64' },
  { goos: 'windows', goarch: 'amd64' },
  { goos: 'windows', goarch: 'arm64' },
];

function nodeOsToGoos(p: string): string {
  return p === 'win32' ? 'windows' : p;
}

function nodeArchToGoarch(a: string): string {
  return a === 'x64' ? 'amd64' : a;
}

function goosToNpmOs(g: string): string {
  return g === 'windows' ? 'win32' : g; // 'linux'/'darwin' map through unchanged
}

function goarchToNpmCpu(g: string): string {
  return g === 'amd64' ? 'x64' : g; // 'arm64' is the same in both
}

function targetLibc(t: Pick<GoTarget, 'goos' | 'libc'>): 'glibc' | 'musl' | undefined {
  if (t.goos !== 'linux') return undefined;
  return t.libc ?? 'glibc';
}

export function targetKey(t: Pick<GoTarget, 'goos' | 'goarch' | 'libc'>): string {
  return targetLibc(t) === 'musl' ? `${t.goos}-${t.goarch}-musl` : `${t.goos}-${t.goarch}`;
}

const VALID_NPM_OS = ['darwin', 'linux', 'win32'];
const VALID_NPM_CPU = ['x64', 'arm64'];

// Every plugin must make an explicit platform statement in its package.json:
// npm-standard `os`/`cpu` arrays (values may be negated with a leading "!"),
// with an EMPTY array meaning "all platforms". Absent fields are rejected so
// plugin authors can't skip the question by accident — camera.ui uses the
// declaration to gate local starts and remote-worker placement.
function validatePlatformDeclaration(packageJson: Record<string, unknown>): void {
  const check = (field: 'os' | 'cpu', valid: string[]) => {
    const value = packageJson[field];

    if (value === undefined) {
      throw new Error(
        `package.json is missing the "${field}" field. Declare the supported platforms explicitly, ` +
        `e.g. "${field}": ${JSON.stringify(valid)} — or "${field}": [] if every platform is supported.`,
      );
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`package.json "${field}" must be an array of strings (npm platform semantics).`);
    }

    for (const entry of value) {
      const name = entry.startsWith('!') ? entry.slice(1) : entry;
      if (!valid.includes(name)) {
        throw new Error(`package.json "${field}" contains "${entry}" — valid values are: ${valid.join(', ')} (optionally negated with "!").`);
      }
    }
  };

  check('os', VALID_NPM_OS);
  check('cpu', VALID_NPM_CPU);
}

function resolveGoTargets(mode: string | undefined, goOpts?: GoBuildOptions): GoTarget[] {
  if (mode === 'development') {
    const hostGoos = nodeOsToGoos(platform()) as GoTarget['goos'];
    const hostGoarch = nodeArchToGoarch(arch()) as GoTarget['goarch'];
    // If the plugin explicitly configured targets, pick the host's settings
    // (cgoEnabled / cc) from there — same iteration semantics as production.
    const matched = goOpts?.targets?.find((t) => t.goos === hostGoos && t.goarch === hostGoarch);
    return [matched ?? { goos: hostGoos, goarch: hostGoarch }];
  }
  if (goOpts?.targets?.length) return goOpts.targets;
  return DEFAULT_GO_TARGETS;
}

export interface StagePlatformPackagesArgs {
  targets: GoTarget[];
  binDir: string;
  bundleDir: string;
  pluginName: string;
  packageScope?: string;
  packageJson: { version?: string; license?: string; [key: string]: unknown };
  rootDir: string;
}

export async function stagePlatformPackages(args: StagePlatformPackagesArgs): Promise<void> {
  log.info('Staging platform packages...');
  const platformsDir = resolve(args.bundleDir, 'platforms');
  await ensureDir(platformsDir);

  const optionalDeps: Record<string, string> = {};

  for (const target of args.targets) {
    const { goos, goarch } = target;
    const key = targetKey(target);
    const libc = targetLibc(target);
    const ext = goos === 'windows' ? '.exe' : '';
    const platformDir = resolve(platformsDir, key);
    await ensureDir(platformDir);

    const binaryName = `${args.pluginName}-${key}${ext}`;
    const sourcePath = resolve(args.binDir, binaryName);
    const targetBinaryName = `${args.pluginName}${ext}`;

    if (!existsSync(sourcePath)) {
      log.error(`  Missing binary for ${key}: ${sourcePath}`);
      throw new Error(`Binary not found: ${sourcePath}`);
    }

    await cp(sourcePath, resolve(platformDir, targetBinaryName));
    await rm(sourcePath);

    const platformPkgName = args.packageScope ? `${args.packageScope}/${args.pluginName}-${key}` : `${args.pluginName}-${key}`;

    const platformPkg = {
      name: platformPkgName,
      version: args.packageJson.version ?? '0.0.1',
      os: [goosToNpmOs(goos)],
      cpu: [goarchToNpmCpu(goarch)],
      // `libc` lets npm skip a glibc build on musl systems (e.g. Alpine) and
      // vice versa — without it npm would install a binary that can't exec.
      ...(libc ? { libc: [libc] } : {}),
      main: targetBinaryName,
      files: [targetBinaryName],
      license: args.packageJson.license ?? 'MIT',
    };

    await writeFile(resolve(platformDir, 'package.json'), JSON.stringify(platformPkg, null, 2));
    optionalDeps[platformPkgName] = platformPkg.version;
  }

  // Update plugin root package.json with optionalDependencies pointing at each
  // platform sub-package. npm installs the matching one (os/cpu/libc) and the
  // server resolves + runs its binary in place at spawn time — no install-time
  // copy, so nothing relies on an npm lifecycle script (npm v12 disables those
  // for dependencies by default).
  const rootPkgPath = resolve(args.rootDir, 'package.json');
  const rootPkgRaw = await readFile(rootPkgPath, 'utf-8');
  const rootPkg = JSON.parse(rootPkgRaw) as { optionalDependencies?: Record<string, string> };
  rootPkg.optionalDependencies = { ...(rootPkg.optionalDependencies ?? {}), ...optionalDeps };
  await writeFile(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

  // Clean up the cross-compile staging dir; binaries now live in platforms/.
  await rm(args.binDir, { recursive: true, force: true });

  log.success(`Staged ${args.targets.length} platform package(s)`);
}

const REQUIRED_FILES: RequiredFile[] = [
  {
    target: 'README.md',
    pattern: /^readme\.md$/i,
  },
  {
    target: 'LICENSE.md',
    pattern: /^license(\.md)?$/i,
  },
  {
    target: 'CHANGELOG.md',
    pattern: /^changelog\.md$/i,
  },
  {
    target: 'logo.png',
    pattern: /^logo\.png$/i,
  },
  {
    target: 'requirements.txt',
    pattern: /^requirements\.txt$/i,
    optional: true,
  },
];

async function copyStandardFiles(rootDir: string, outDir: string): Promise<void> {
  log.info('Copying standard files...');

  for (const file of REQUIRED_FILES) {
    const foundFile = await findFile(rootDir, file);

    if (foundFile) {
      await copyPath(rootDir, foundFile, outDir, file.target);
    } else if (!file.optional) {
      log.missingFile(file.target);
    }
  }
}

async function copyAdditionalFiles(rootDir: string, paths: string[] | { source: string; target: string }[], outDir: string): Promise<void> {
  log.info('Copying additional files...');
  for (const path of paths) {
    if (typeof path === 'string') {
      await copyPath(rootDir, path, resolve(outDir, 'dist'), path.split('/').pop());
    } else {
      await copyPath(rootDir, path.source, resolve(outDir, 'dist'), path.target);
    }
  }
}

async function stripPlatformPythonRequirements(bundleDir: string): Promise<void> {
  const requirementsPath = resolve(bundleDir, 'requirements.txt');
  if (!existsSync(requirementsPath)) {
    return;
  }

  const content = await readFile(requirementsPath, 'utf-8');
  const kept = content.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return true;
    }
    // Package name is everything before a version specifier, extras, or marker.
    const name = trimmed.split(/[=<>!~;[ ]/)[0];
    return !isPlatformPackagePython(name);
  });

  await writeFile(requirementsPath, kept.join('\n'));
}

interface ProcessPackageJsonOptions {
  rootDir: string;
  outDir: string;
  external: (string | RegExp)[];
  pluginLanguage: PluginLanguage;
  goTargets?: GoTarget[];
  isDev?: boolean;
}

async function processPackageJson({ rootDir, outDir, external, pluginLanguage, goTargets, isDev }: ProcessPackageJsonOptions): Promise<void> {
  try {
    log.info('Processing package.json...');

    const packageJsonPath = resolve(rootDir, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    const mainFile = pluginLanguage === 'python' ? 'main.py' : pluginLanguage === 'go' ? 'main.go' : 'index.js';
    packageJson.main = pluginLanguage === 'go' ? './main.go' : `./dist/${mainFile}`;

    // Go plugins: derive the npm platform declaration from the build targets —
    // they ARE the truth about where the plugin can run.
    if (pluginLanguage === 'go' && goTargets?.length) {
      packageJson.os ??= [...new Set(goTargets.map((t) => goosToNpmOs(t.goos)))];
      packageJson.cpu ??= [...new Set(goTargets.map((t) => goarchToNpmCpu(t.goarch)))];
    }

    validatePlatformDeclaration(packageJson);

    packageJson.type = 'commonjs';

    delete packageJson.private;

    delete packageJson.devDependencies;

    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = packageJson[section] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (isPlatformPackageNode(name)) {
          delete deps[name];
        }
      }
      if (Object.keys(deps).length === 0) {
        delete packageJson[section];
      }
    }

    if (packageJson.dependencies) {
      const newDependencies: Record<string, string> = {};

      for (const [dep, version] of Object.entries<string>(packageJson.dependencies)) {
        const requiredDependency = external.some((ext) => {
          if (typeof ext === 'string') {
            return dep === ext || dep.startsWith(`${ext}/`);
          }
          return ext.test(dep);
        });

        if (requiredDependency) {
          newDependencies[dep] = version;
        }
      }

      if (Object.keys(newDependencies).length > 0) {
        packageJson.dependencies = newDependencies;
      } else {
        delete packageJson.dependencies;
      }
    }

    // Go production: inject optionalDependencies and postinstall script
    if (pluginLanguage === 'go' && goTargets?.length && !isDev) {
      const pluginName = (packageJson.name as string).replace(/^@[^/]+\//, '');
      const packageScope = (packageJson.name as string).includes('/') ? (packageJson.name as string).split('/')[0] : undefined;
      const version = packageJson.version ?? '0.0.1';

      const optionalDeps: Record<string, string> = {};
      for (const target of goTargets) {
        const key = targetKey(target);
        const platformPkgName = packageScope ? `${packageScope}/${pluginName}-${key}` : `${pluginName}-${key}`;
        optionalDeps[platformPkgName] = version;
      }

      packageJson.optionalDependencies = optionalDeps;
    }

    // Lean main package: the server only needs bundle.zip (it extracts it on
    // install). This keeps the platform binaries staged under bundle/platforms/
    // out of the main tarball — each ships in its own platform package via
    // optionalDependencies instead of being duplicated into every install.
    // package.json/README/LICENSE are auto-included by npm; CHANGELOG isn't, so
    // it's listed explicitly to keep it on the npm page.
    packageJson.files = ['bundle.zip', 'CHANGELOG.md'];

    const targetPath = resolve(outDir, 'package.json');
    await writeFile(targetPath, JSON.stringify(packageJson, null, 2));
    log.success('Package.json processed');
  } catch (error) {
    log.error('Failed to process package.json');
    throw error;
  }
}

async function createBundleZip(bundleDir: string): Promise<void> {
  try {
    log.info('Creating bundle archive...');

    const tempDir = resolve(bundleDir, '.temp');
    await mkdir(tempDir, { recursive: true });

    const staticFiles = ['bundle.zip', '.temp', 'package.json', 'CHANGELOG.md', 'LICENSE.md', 'README.md', 'platforms'];
    const files = await readdir(bundleDir);

    for (const file of files) {
      if (!staticFiles.slice(1).includes(file)) {
        await cp(resolve(bundleDir, file), resolve(tempDir, file), { recursive: true, force: true });
      }
    }

    const zip = new AdmZip();
    zip.addLocalFolder(tempDir);
    zip.writeZip(resolve(bundleDir, 'bundle.zip'));

    for (const file of files) {
      if (!staticFiles.includes(file)) {
        await rm(resolve(bundleDir, file), { recursive: true, force: true });
      }
    }

    await rm(tempDir, { recursive: true, force: true });

    const stats = await stat(resolve(bundleDir, 'bundle.zip'));
    const sizeInMB = stats.size / (1024 * 1024);
    log.bundleSize(sizeInMB);
  } catch (error) {
    log.error('Failed to create bundle archive');
    throw error;
  }
}

export interface FinalizeBundleArgs {
  targetRootDir: string;
  bundleDir: string;
  rootDir: string;
  pluginLanguage: PluginLanguage;
  external: (string | RegExp)[];
  additionalFiles?: string[] | { source: string; target: string }[];
  goTargets?: GoTarget[];
  isDev: boolean;
}

export async function finalizeBundle(args: FinalizeBundleArgs): Promise<void> {
  const { targetRootDir, bundleDir, rootDir, pluginLanguage, external, additionalFiles, goTargets, isDev } = args;

  // Bundle contract.ts (always at root level, required for all plugins)
  const contractInput = resolve(targetRootDir, 'contract.ts');

  if (!existsSync(contractInput)) {
    throw new Error(`Missing contract.ts at ${contractInput}. Every plugin requires a contract.ts file at the project root.`);
  }

  log.info('Bundling contract...');

  // Bundle contract with esbuild - no externals, enum values are inlined
  // Use .cjs extension to ensure Node.js treats it as CommonJS regardless of package.json "type"
  await esbuild.build({
    entryPoints: [contractInput],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: resolve(bundleDir, 'contract.cjs'),
    sourcemap: isDev,
    minify: false, // Keep contract readable for debugging
    logLevel: 'warning',
  });
  log.success('Contract bundled');

  // Validate contract
  log.info('Validating contract...');
  const contractPath = resolve(bundleDir, 'contract.cjs');
  const contractModule = await import(pathToFileURL(contractPath).href);
  const contract = contractModule.contract ?? contractModule.default;

  if (!contract) {
    throw new Error('Contract not found. Ensure your contract.ts exports "contract" or uses a default export.');
  }

  const validationErrors = getContractValidationErrors(contract);
  if (validationErrors.length > 0) {
    const errorList = validationErrors.map((e) => `  - ${e}`).join('\n');
    throw new Error(`Invalid contract structure:\n${errorList}`);
  }

  validateContractConsistency(contract);
  log.success('Contract validated');

  await copyStandardFiles(rootDir, bundleDir);

  if (pluginLanguage === 'python') {
    await stripPlatformPythonRequirements(bundleDir);
  }

  if (additionalFiles?.length) {
    await copyAdditionalFiles(rootDir, additionalFiles, bundleDir);
  }

  await processPackageJson({
    rootDir,
    outDir: bundleDir,
    external,
    pluginLanguage,
    goTargets,
    isDev,
  });

  if (!isDev) {
    await createBundleZip(bundleDir);
  }
}

export interface BuildOptions {
  target?: string;
}

export async function buildProject(options: BuildOptions = {}): Promise<void> {
  const startTime = Date.now();
  showIntro();

  log.info('Starting build...');

  const { userConfig, targetRootDir, entryPoint, outputFile } = await parseConfig();

  const bundleDir = resolve(outputFile, '..', '..');
  const rootDir = userConfig.rootDir ? resolve(process.cwd(), userConfig.rootDir) : process.cwd();
  const pluginLanguage = userConfig.language ?? (await detectLanguage(rootDir));

  await rm(bundleDir, { recursive: true, force: true });

  let goTargets: GoTarget[] | undefined;

  try {
    if (pluginLanguage === 'go') {
      // Go: cross-compile binaries
      await ensureDir(bundleDir);
      const binDir = resolve(bundleDir, 'dist', 'bin');
      await ensureDir(binDir);

      log.info('Cross-compiling Go plugin...');

      const packageJsonPath = resolve(rootDir, 'package.json');
      const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);
      const pluginName = (packageJson.name as string).replace(/^@[^/]+\//, '');
      const packageScope = (packageJson.name as string).includes('/') ? (packageJson.name as string).split('/')[0] : undefined;

      const goOpts = userConfig.go;
      let targets = resolveGoTargets(userConfig.mode, goOpts);

      // --target restricts the build to a single configured platform. The
      // per-platform packaging step (writing `bundle/platforms/...`) is also
      // skipped — that's the `artifacts` command's job once all matrix jobs
      // have uploaded their respective binaries.
      if (options.target) {
        // The --target value is a canonical target key: <goos>-<goarch> or, for
        // musl linux builds, <goos>-<goarch>-musl (e.g. linux-amd64-musl).
        const match = targets.find((t) => targetKey(t) === options.target);
        if (!match) {
          const available = targets.map((t) => targetKey(t)).join(', ');
          throw new Error(`--target ${options.target} not in plugin's configured targets [${available}]`);
        }
        targets = [match];
      }

      goTargets = targets;
      const defaultLdflags = goOpts?.ldflags ?? '-s -w';
      const defaultCgoEnabled = goOpts?.cgoEnabled ?? '0';
      const extraEnv = goOpts?.env ?? {};
      const defaultCompiler = goOpts?.compiler ?? 'go';
      const defaultCompilerArgs = goOpts?.compilerArgs ?? [];

      const isDev = userConfig.mode === 'development';

      for (const target of targets) {
        const { goos, goarch } = target;
        const key = targetKey(target);
        const ext = goos === 'windows' ? '.exe' : '';
        // Naming:
        //  - dev mode (no --target): unsuffixed `plugin` for direct local run
        //  - --target / production: `<pluginName>-<key>[.exe]` (key encodes the
        //    target incl. a -musl suffix) so matrix runners can upload an
        //    artifact whose name encodes the target, and the `artifacts`
        //    command can match it back
        const outputName = isDev && !options.target ? `plugin${ext}` : `${pluginName}-${key}${ext}`;
        const outputPath = resolve(binDir, outputName);
        // Per-target CGo + CC overrides — `cameraui.config.ts` can opt in
        // CGo only for the platforms that need it (e.g. darwin Foundation
        // framework bindings) without dragging Linux/Windows builds into a
        // C cross-compile setup.
        const targetCgoEnabled = target.cgoEnabled ?? defaultCgoEnabled;
        const targetLdflags = target.ldflags ?? defaultLdflags;
        const targetEnv: Record<string, string> = {
          ...extraEnv,
          CGO_ENABLED: targetCgoEnabled,
          GOOS: goos,
          GOARCH: goarch,
        };
        if (target.cc) targetEnv.CC = target.cc;
        const useOverride = !(isDev && !options.target);
        const compiler = useOverride ? (target.compiler ?? defaultCompiler) : 'go';
        const compilerArgs = useOverride ? (target.compilerArgs ?? defaultCompilerArgs) : [];
        const cgoLabel = targetCgoEnabled === '1' ? ' [CGO]' : '';
        const compilerLabel = compiler !== 'go' ? ` [${compiler}]` : '';
        log.info(`  Building ${pluginName}-${key}${ext}${cgoLabel}${compilerLabel}...`);
        try {
          // execFileSync (no shell) avoids cross-platform quoting headaches —
          // PowerShell on Windows doesn't strip single quotes, so a shell-style
          // `-ldflags '-s -w …'` would land at `go build` with the quotes
          // intact and fail. Passing args as an array side-steps shell parsing
          // entirely.
          execFileSync(compiler, [...compilerArgs, 'build', '-ldflags', targetLdflags, '-o', outputPath, './src/'], {
            cwd: rootDir,
            stdio: 'pipe',
            env: { ...process.env, ...targetEnv },
          });
          log.success(`  Built ${pluginName}-${key}${ext}`);
        } catch (err) {
          log.error(`  Failed to build ${pluginName}-${key}${ext}: ${(err as Error).message}`);
          throw err;
        }
      }

      // Production multi-target build: generate per-platform npm packages.
      // Skipped in single-target (--target) mode — each matrix job just emits
      // its binary into bundle/dist/bin/ for the `artifacts` command to pick
      // up later in the publish stage.
      if (!isDev && !options.target) {
        await stagePlatformPackages({
          targets,
          binDir,
          bundleDir,
          pluginName,
          packageScope,
          packageJson,
          rootDir,
        });
      }

      log.success('Go plugin compiled');

      // --target single-target mode (matrix CI): the only output we need
      // is the platform-suffixed binary at `bundle/dist/bin/`. Skip the
      // contract bundle, README copy, package.json rewrite, and zip — those
      // are the publish-stage's job, where `cui artifacts` aggregates one
      // binary per matrix runner into the final per-platform packages.
      if (options.target) {
        const duration = Date.now() - startTime;
        log.buildSuccess(bundleDir, duration);
        showOutro('Build complete!');
        return;
      }
    } else if (pluginLanguage === 'python') {
      // Python: copy source files to dist/
      await ensureDir(bundleDir);
      await copyPath(rootDir, 'src', bundleDir, 'dist');
    } else {
      // TypeScript/JavaScript: bundle with esbuild
      // esbuild handles CJS/ESM interop much better than Rollup for export * re-exports
      log.info('Bundling plugin...');

      // Build external list: host-provided platform packages + user externals.
      // Platform packages are resolved from the host at runtime
      // via NODE_PATH, never bundled.
      const externals: string[] = [...PLATFORM_PACKAGES_NODE];

      // Add user-defined externals (convert RegExp to string patterns for esbuild)
      if (userConfig.external) {
        for (const ext of userConfig.external) {
          if (typeof ext === 'string') {
            externals.push(ext);
          }
          // Note: esbuild doesn't support RegExp externals, skip them
        }
      }

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile: outputFile,
        sourcemap: userConfig.mode === 'development',
        minify: userConfig.mode !== 'development',
        keepNames: true,
        treeShaking: userConfig.mode !== 'development',
        external: externals,
        logLevel: 'warning',
        // Handle native .node modules and packages with native bindings
        plugins: [
          {
            name: 'native-node-modules',
            setup(build) {
              // Mark all .node files as external
              build.onResolve({ filter: /\.node$/ }, (args) => ({
                path: args.path,
                external: true,
              }));

              // Mark common native module packages as external
              // These patterns match packages that typically contain native bindings
              const nativePackagePatterns = [/^@camera\.ui\/rust-/, /^@napi-rs\//, /-darwin-/, /-linux-/, /-win32-/, /-arm64$/, /-x64$/];

              build.onResolve({ filter: /.*/ }, (args) => {
                for (const pattern of nativePackagePatterns) {
                  if (pattern.test(args.path)) {
                    return { path: args.path, external: true };
                  }
                }
                return null;
              });
            },
          },
        ],
      });
      log.success('Plugin bundled');
    }

    const external = Array.isArray(userConfig.external) ? userConfig.external : [];
    await finalizeBundle({
      targetRootDir,
      bundleDir,
      rootDir,
      pluginLanguage,
      external,
      additionalFiles: userConfig.additionalFiles,
      goTargets,
      isDev: userConfig.mode === 'development',
    });

    const duration = Date.now() - startTime;
    log.buildSuccess(bundleDir, duration);

    showOutro('Build complete!');
  } catch (error) {
    log.buildError(error);
    process.exit(1);
  }
}
