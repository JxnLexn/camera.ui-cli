import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from '../utils/pjson.js';
import { sortDependencies, sortScripts } from './sort.js';
import { copyPath, ensureDir } from './utils.js';
import { getLatestCameraUiVersion, getLatestNodeLTSVersion } from './versions.js';

import type { SensorType } from '@camera.ui/sdk';
import type { CreateOptions } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function createVscodeSettings(targetDir: string, options: CreateOptions): Promise<void> {
  const vscodeFiles = ['settings.json'];

  const vscodeBaseExtensions = [
    'redhat.vscode-yaml',
    'VisualStudioExptTeam.vscodeintellicode',
    'xabikos.JavaScriptSnippets',
    'christian-kohler.npm-intellisense',
    'fill-labs.dependi',
  ];

  const vscodeQualityExtensions = ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'];

  const vscodePythonExtensions = [
    'charliermarsh.ruff',
    'ms-python.isort',
    'KevinRose.vsc-python-indent',
    'ms-python.vscode-pylance',
    'ms-python.python',
    'ms-python.debugpy',
    'donjayamanne.python-environment-manager',
    'tamasfe.even-better-toml',
  ];

  const extensions: string[] = [...vscodeBaseExtensions];

  if (options.quality) {
    extensions.push(...vscodeQualityExtensions);
  }

  if (options.language === 'python') {
    extensions.push(...vscodePythonExtensions);
  }

  const vscodeDir = resolve(targetDir, '.vscode');
  await ensureDir(vscodeDir);

  for (const file of vscodeFiles) {
    await copyPath(__dirname, `../../templates/base/vscode/${file}`, vscodeDir, file);
  }

  const extensionsPath = resolve(vscodeDir, 'extensions.json');
  const extensionsContent = JSON.stringify({ recommendations: extensions }, null, 2);
  await writeFile(extensionsPath, extensionsContent);
}

export async function createBaseFiles(targetDir: string, projectName: string, options: CreateOptions): Promise<void> {
  const baseFiles = ['README.md', 'LICENSE.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'updates.config.js'];
  const baseDotFiles = ['gitignore', 'npmignore', 'editorconfig'];

  // cameraui.config.ts is always TypeScript (even for Python plugins)
  const configFiles: string[] = ['cameraui.config.ts'];
  const pythonFiles: string[] = ['cupdate.config.txt'];

  for (const file of baseFiles) {
    await copyPath(__dirname, `../../templates/base/${file}`, targetDir, file);
  }

  for (const file of baseDotFiles) {
    await copyPath(__dirname, `../../templates/base/${file}`, targetDir, `.${file}`);
  }

  // Always copy TypeScript config file
  for (const file of configFiles) {
    await copyPath(__dirname, `../../templates/typescript/${file}`, targetDir, file);
  }

  // Python-specific files
  if (options.language === 'python') {
    for (const file of pythonFiles) {
      await copyPath(__dirname, `../../templates/python/${file}`, targetDir, file);
    }
  }

  const readmePath = resolve(targetDir, 'README.md');
  const readmeContent = readFileSync(readmePath, 'utf-8').replace(/{{projectName}}/g, projectName);

  await writeFile(readmePath, readmeContent);

  await createVscodeSettings(targetDir, options);
}

export async function createPackageJson(projectName: string, options: CreateOptions): Promise<any> {
  const pJsonPath = resolve(join(__dirname, '../../templates/base/package.json'));
  const pJson = JSON.parse(readFileSync(pJsonPath, 'utf-8'));

  // general
  pJson.displayName = options.displayName;
  pJson.name = projectName;

  const mainFile = options.language === 'python' ? 'main.py' : options.language === 'go' ? 'main.go' : 'index.js';
  pJson.main = options.language === 'go' ? './bundle/main.go' : `./bundle/dist/${mainFile}`;

  // scripts
  pJson.scripts = {
    bundle: 'cui bundle',
    'bundle:dev': 'cross-env MODE=development cui bundle',
    'install-updates': 'npm i --save',
    update: 'updates --update ./',
    prepublishOnly:
      // prettier-ignore
      // eslint-disable-next-line @stylistic/max-len
      "node -e \"if(!process.env.SAFE_PUBLISH){console.error('Error: Please use @camera.ui/cli to publish the plugin:\\n  npm run publish:alpha\\n  npm run publish:beta\\n  npm run publish:latest\\n');process.exit(1)}\"",
    'publish:alpha': 'npm i --save && npm run bundle && cui publish --alpha',
    'publish:beta': 'npm i --save && npm run bundle && cui publish --beta',
    'publish:latest': 'npm i --save && npm run bundle && cui publish --latest',
  };

  if (options.language === 'typescript') {
    pJson.scripts.build = 'rimraf dist && tsc';
  } else if (options.language === 'python') {
    pJson.scripts.update = pJson.scripts.update + ' && cupdate';
    pJson.scripts.build = 'mypy src';
  } else if (options.language === 'go') {
    pJson.scripts.build = 'go build -o /dev/null ./src/';
  }

  if (options.quality) {
    if (options.language === 'go') {
      pJson.scripts.format = 'gofmt -w .';
      pJson.scripts.lint = 'go vet ./...';
    } else if (options.language === 'python') {
      pJson.scripts.format = 'ruff format';
      pJson.scripts.lint = 'ruff check --fix';
    } else {
      pJson.scripts.format = 'prettier --write "src/" --ignore-unknown --no-error-on-unmatched-pattern';
      pJson.scripts.lint = 'eslint --fix .';
    }
  }

  if (pJson.scripts.build) {
    pJson.scripts.bundle = 'npm run build && ' + pJson.scripts.bundle;
    pJson.scripts['bundle:dev'] = 'npm run build && ' + pJson.scripts['bundle:dev'];
  }

  if (pJson.scripts.lint) {
    pJson.scripts.bundle = 'npm run lint && ' + pJson.scripts.bundle;
    pJson.scripts['bundle:dev'] = 'npm run lint && ' + pJson.scripts['bundle:dev'];
  }

  if (pJson.scripts.format) {
    pJson.scripts.bundle = 'npm run format && ' + pJson.scripts.bundle;
    pJson.scripts['bundle:dev'] = 'npm run format && ' + pJson.scripts['bundle:dev'];
  }

  pJson.scripts = sortScripts(pJson);

  // devDependencies - always include TypeScript (needed for contract.ts)
  const tsPJsonPath = resolve(join(__dirname, '../../templates/typescript/package.json'));
  const tsPJson = JSON.parse(readFileSync(tsPJsonPath, 'utf-8'));

  pJson.devDependencies = {
    ...pJson.devDependencies,
    '@camera.ui/cli': `^${packageJson.version}`,
    ...tsPJson,
  };

  // Code quality tools (ESLint + Prettier for TypeScript only)
  if (options.quality && options.language === 'typescript') {
    const formatterPJsonPath = resolve(join(__dirname, '../../templates/base/package.prettier.json'));
    const formatterPJson = JSON.parse(readFileSync(formatterPJsonPath, 'utf-8'));

    const baseLinterPjsonPath = resolve(join(__dirname, '../../templates/base/package.eslint.json'));
    const baseLinterPjson = JSON.parse(readFileSync(baseLinterPjsonPath, 'utf-8'));

    const linterPJsonPath = resolve(join(__dirname, '../../templates/typescript/package.eslint.json'));
    const linterPJson = JSON.parse(readFileSync(linterPJsonPath, 'utf-8'));

    pJson.devDependencies = {
      ...pJson.devDependencies,
      ...baseLinterPjson,
      ...formatterPJson,
      ...linterPJson,
    };
  }

  // engines
  const latestCameraUiVersion = await getLatestCameraUiVersion();
  const latestNodeVersion = await getLatestNodeLTSVersion();

  pJson.engines['camera.ui'] = `>=${latestCameraUiVersion.latest}`;
  pJson.engines.node = `>=${latestNodeVersion.version}`;

  // contract
  pJson['camera.ui'] = {
    provides: options.provides,
    consumes: options.consumes,
    dependencies: [],
    pythonVersion: options.pythonVersion,
  };

  return sortDependencies(pJson);
}

export async function createPythonRequirements(targetDir: string): Promise<void> {
  const files = ['requirements.txt', 'requirements.dev.txt'];

  for (const file of files) {
    await copyPath(__dirname, `../../templates/python/${file}`, targetDir, file);
  }
}

export async function createMyPyConfig(targetDir: string): Promise<void> {
  await copyPath(__dirname, '../../templates/python/mypy.ini', targetDir, 'mypy.ini');
}

export async function createTsConfig(targetDir: string, options: CreateOptions): Promise<void> {
  if (options.language === 'typescript') {
    // Full TypeScript config for TS projects
    await copyPath(__dirname, '../../templates/typescript/tsconfig.json', targetDir, 'tsconfig.json');
  } else {
    // Minimal TypeScript config for Python projects (only needed for contract.ts)
    const minimalTsConfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: false,
        outDir: './dist',
      },
      include: ['contract.ts'],
      exclude: ['node_modules', 'bundle', 'dist'],
    };
    await writeFile(resolve(targetDir, 'tsconfig.json'), JSON.stringify(minimalTsConfig, null, 2));
  }
}

export async function createCodeQualityConfig(targetDir: string, options: CreateOptions): Promise<void> {
  if (options.language === 'python') {
    // Python: ruff for linting/formatting
    await copyPath(__dirname, '../../templates/python/ruff.toml', targetDir, 'ruff.toml');
  } else {
    // TypeScript: ESLint + Prettier
    await copyPath(__dirname, '../../templates/base/prettierrc.json', targetDir, '.prettierrc.json');
    await copyPath(__dirname, '../../templates/base/prettierignore', targetDir, '.prettierignore');
    await copyPath(__dirname, '../../templates/typescript/eslint.config.js', targetDir, 'eslint.config.js');
  }
}

function formatSensorTypesForTs(types: SensorType[]): string {
  if (types.length === 0) return '[]';

  const sensorTypeMap: Record<string, string> = {
    motion: 'Motion',
    object: 'Object',
    audio: 'Audio',
    face: 'Face',
    licensePlate: 'LicensePlate',
    contact: 'Contact',
    light: 'Light',
    siren: 'Siren',
    ptz: 'PTZ',
    doorbell: 'Doorbell',
    battery: 'Battery',
  };

  const formatted = types.map((t) => `SensorType.${sensorTypeMap[t] || t}`).join(', ');
  return `[${formatted}]`;
}

function generateContractTs(options: CreateOptions): string {
  const provides = formatSensorTypesForTs(options.provides);
  const consumes = formatSensorTypesForTs(options.consumes);

  return `import { SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

/**
 * Plugin Contract
 *
 * This file defines what sensor types your plugin provides and consumes.
 * It is bundled separately and read by camera.ui before loading the plugin.
 *
 * - provides: Sensor types this plugin creates and controls
 * - consumes: Sensor types this plugin receives updates from (for hubs/integrations)
 */
export const contract: PluginContract = {
  name: '${options.displayName}',
  provides: ${provides},
  consumes: ${consumes},
};

export default contract;
`;
}

/**
 * Create contract.ts at project root (always TypeScript, even for Python plugins)
 * This file is bundled to contract.js during the bundle process
 */
export async function createContractFile(targetDir: string, options: CreateOptions): Promise<void> {
  const contractContent = generateContractTs(options);
  await writeFile(resolve(targetDir, 'contract.ts'), contractContent);
}

/**
 * Create source files in src/ directory (no contract files here)
 */
export async function createSourceFiles(targetDir: string, options: CreateOptions): Promise<void> {
  const srcDir = resolve(targetDir, 'src');
  await ensureDir(srcDir);

  if (options.language === 'python') {
    await copyPath(__dirname, '../../templates/python/src/main.py', srcDir, 'main.py');
  } else if (options.language === 'go') {
    // Go source files are created separately by createGoFiles
  } else {
    // TypeScript
    await copyPath(__dirname, '../../templates/typescript/src/index.ts', srcDir, 'index.ts');
    await copyPath(__dirname, '../../templates/typescript/src/sensor.ts', srcDir, 'sensor.ts');
  }
}

/**
 * Create Go source files for a new Go plugin project
 */
export async function createGoFiles(targetDir: string, projectName: string): Promise<void> {
  const srcDir = resolve(targetDir, 'src');
  await ensureDir(srcDir);

  const pluginName = projectName.replace(/^@[^/]+\//, '').replace(/-/g, '_');
  const moduleName = `github.com/user/${projectName.replace(/^@[^/]+\//, '')}`;

  // go.mod — read template, replace placeholder, write to project root
  const goModTemplate = readFileSync(resolve(__dirname, '../../templates/go/go.mod'), 'utf-8');
  const goMod = goModTemplate.replace(/\{\{moduleName\}\}/g, moduleName);
  await writeFile(resolve(targetDir, 'go.mod'), goMod);

  // main.go — read template, replace placeholder, write to src/
  const mainGoTemplate = readFileSync(resolve(__dirname, '../../templates/go/src/main.go'), 'utf-8');
  const mainGo = mainGoTemplate.replace(/\{\{pluginName\}\}/g, pluginName);
  await writeFile(resolve(srcDir, 'main.go'), mainGo);
}
