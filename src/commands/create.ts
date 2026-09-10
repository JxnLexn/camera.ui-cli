import { SensorType } from '@camera.ui/sdk';
import { confirm, isCancel, multiselect, select, text } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pc from 'picocolors';

import { showCancel, showIntro, showOutro } from '../utils/banners.js';
import * as log from '../utils/logger.js';
import { isQualifiedPluginIdentifier, PLUGIN_IDENTIFIER, transformDisplaName } from '../utils/pluginName.js';
import {
  createBaseFiles,
  createCodeQualityConfig,
  createContractFile,
  createGoFiles,
  createMyPyConfig,
  createPackageJson,
  createPythonRequirements,
  createSourceFiles,
  createTsConfig,
} from '../utils/templates.js';
import { ensureDir } from '../utils/utils.js';

import type { CreateOptions, PluginLanguage, PluginRole } from '../types.js';

type SelectableSensorType = Exclude<SensorType, SensorType.ObjectAssist>;

// A new SensorType fails to compile until it gets a label here
const SENSOR_LABELS: Record<SelectableSensorType, string> = {
  [SensorType.Motion]: 'Motion Detection',
  [SensorType.Object]: 'Object Detection',
  [SensorType.Audio]: 'Audio Detection',
  [SensorType.Face]: 'Face Detection',
  [SensorType.LicensePlate]: 'License Plate',
  [SensorType.Classifier]: 'Classifier',
  [SensorType.Clip]: 'CLIP Embedding',
  [SensorType.Contact]: 'Contact Sensor',
  [SensorType.Occupancy]: 'Occupancy Sensor',
  [SensorType.Smoke]: 'Smoke Sensor',
  [SensorType.Leak]: 'Leak Sensor',
  [SensorType.Gas]: 'Gas Sensor',
  [SensorType.CarbonMonoxide]: 'Carbon Monoxide Sensor',
  [SensorType.Heat]: 'Heat Sensor',
  [SensorType.Cold]: 'Cold Sensor',
  [SensorType.Vibration]: 'Vibration Sensor',
  [SensorType.Tamper]: 'Tamper Sensor',
  [SensorType.Problem]: 'Problem Sensor',
  [SensorType.Power]: 'Power Sensor',
  [SensorType.Doorbell]: 'Doorbell',
  [SensorType.Temperature]: 'Temperature',
  [SensorType.Humidity]: 'Humidity',
  [SensorType.Illuminance]: 'Illuminance',
  [SensorType.CarbonDioxide]: 'Carbon Dioxide',
  [SensorType.Battery]: 'Battery',
  [SensorType.Light]: 'Light Control',
  [SensorType.Siren]: 'Siren Control',
  [SensorType.Switch]: 'Switch Control',
  [SensorType.Lock]: 'Lock Control',
  [SensorType.Garage]: 'Garage Control',
  [SensorType.SecuritySystem]: 'Security System',
  [SensorType.PTZ]: 'PTZ Control',
};

type SensorOption = { [K in SelectableSensorType]: { value: K; label: string } }[SelectableSensorType];

const SENSOR_OPTIONS = Object.values(SensorType)
  .filter((value): value is SelectableSensorType => value !== SensorType.ObjectAssist)

  .map((value) => ({ value, label: SENSOR_LABELS[value] }) as SensorOption);

function handleCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    showCancel('Operation cancelled');
    process.exit(0);
  }
  return value as T;
}

export async function createProject(projectName: string) {
  showIntro();

  if (!projectName) {
    log.error('Project name is required');
    process.exit(1);
  }

  if (!isQualifiedPluginIdentifier(projectName)) {
    projectName = 'camera-ui-' + projectName.replace(PLUGIN_IDENTIFIER, '').toLowerCase();
  }

  const targetDir = resolve(process.cwd(), projectName);

  try {
    const exists = existsSync(targetDir);
    if (exists) {
      const action = handleCancel(
        await select({
          message: `Target directory "${projectName}" already exists. Pick an action:`,
          options: [
            { value: 'overwrite', label: 'Overwrite' },
            { value: 'cancel', label: 'Cancel' },
          ],
        }),
      );

      if (action === 'cancel') {
        showCancel('Operation cancelled');
        process.exit(0);
      }

      log.info(`Removing existing directory: ${projectName}`);
      await rm(targetDir, { recursive: true, force: true });
    }
  } catch (err) {
    log.error(`Error checking directory: ${(err as Error).message}`);
    process.exit(1);
  }

  const displayName = handleCancel(
    await text({
      message: 'Display name:',
      placeholder: transformDisplaName(projectName),
      defaultValue: transformDisplaName(projectName),
    }),
  );

  const language = handleCancel(
    await select({
      message: 'Select programming language:',
      options: [
        { value: 'typescript' as PluginLanguage, label: 'TypeScript', hint: 'recommended' },
        { value: 'python' as PluginLanguage, label: 'Python' },
        { value: 'go' as PluginLanguage, label: 'Go' },
      ],
    }),
  );

  let pythonVersion: '3.11' | '3.12' | undefined;
  if (language === 'python') {
    pythonVersion = handleCancel(
      await select({
        message: 'Select Python version:',
        options: [
          { value: '3.11' as const, label: '3.11' },
          { value: '3.12' as const, label: '3.12' },
        ],
      }),
    );
  }

  const quality =
    language === 'go'
      ? true
      : handleCancel(
          await confirm({
            message: `Add ${language === 'python' ? 'ruff' : 'ESLint & Prettier'} for code quality?`,
            initialValue: true,
          }),
        );

  // Plugin role determines which sensor type questions to ask
  const role = handleCancel(
    await select({
      message: "What is your plugin's role?",
      options: [
        { value: 'provider' as PluginRole, label: 'Provider', hint: 'creates and controls sensors' },
        { value: 'consumer' as PluginRole, label: 'Consumer/Hub', hint: 'receives sensor data from other plugins' },
        { value: 'both' as PluginRole, label: 'Both', hint: 'provides sensors and consumes from others' },
      ],
    }),
  );

  let provides: SensorType[] = [];
  let consumes: SensorType[] = [];

  if (role === 'provider' || role === 'both') {
    provides = handleCancel(
      await multiselect({
        message: `Which sensor types will your plugin PROVIDE? ${pc.dim('(space to select)')}`,
        options: SENSOR_OPTIONS,
        required: false,
      }),
    );
  }

  if (role === 'consumer' || role === 'both') {
    consumes = handleCancel(
      await multiselect({
        message: `Which sensor types will your plugin CONSUME? ${pc.dim('(space to select)')}`,
        options: SENSOR_OPTIONS,
        required: false,
      }),
    );
  }

  const options: CreateOptions = {
    displayName,
    language,
    pythonVersion,
    quality,
    role,
    provides,
    consumes,
  };

  try {
    await ensureDir(targetDir);
    log.success(`Created project directory: ${projectName}`);

    await createBaseFiles(targetDir, projectName, options);
    log.success('Created base files');

    const packageJson = await createPackageJson(projectName, options);
    await writeFile(resolve(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2));
    log.success('Created package.json');

    // Always create tsconfig.json (needed for contract.ts compilation)
    await createTsConfig(targetDir, options);
    log.success('Created tsconfig.json');

    // Always create contract.ts at root level
    await createContractFile(targetDir, options);
    log.success('Created contract.ts');

    if (options.language === 'python') {
      await createPythonRequirements(targetDir);
      log.success('Created requirements.txt');

      await createMyPyConfig(targetDir);
      log.success('Created mypy configuration');
    }

    if (options.language === 'go') {
      await createGoFiles(targetDir, projectName);
      log.success('Created Go files');
    }

    if (options.quality) {
      await createCodeQualityConfig(targetDir, options);
      log.success('Created code quality configuration');
    }

    await createSourceFiles(targetDir, options);
    log.success('Created source files');

    const nextSteps = [`${pc.bold(pc.cyan(`cd ${projectName}`))}`, `${pc.bold(pc.cyan('npm install'))}`];

    if (options.language === 'python') {
      nextSteps.push(`${pc.bold(pc.cyan('pip install -r requirements.txt'))}`);
      nextSteps.push(`${pc.bold(pc.cyan('pip install -r requirements.dev.txt'))}`);
    }

    if (options.language === 'go') {
      nextSteps.push(`${pc.bold(pc.cyan('cd src && go mod tidy'))}`);
    }

    nextSteps.push(`${pc.bold(pc.cyan('npm run bundle'))}`);

    showOutro(`${pc.green('Done!')} Next steps:\n\n  ${nextSteps.join('\n  ')}`);
  } catch (err) {
    log.buildError(err);
    process.exit(1);
  }
}
