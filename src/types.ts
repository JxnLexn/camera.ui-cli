import type { PythonVersion, SensorType } from '@camera.ui/sdk';

export type PluginLanguage = 'python' | 'typescript' | 'go';

export interface GoTarget {
  goos: 'linux' | 'darwin' | 'windows';
  goarch: 'amd64' | 'arm64';
  libc?: 'glibc' | 'musl';
  cgoEnabled?: '0' | '1';
  cc?: string;
  ldflags?: string;
}

export interface GoBuildOptions {
  targets?: GoTarget[];
  ldflags?: string;
  cgoEnabled?: '0' | '1';
  env?: Record<string, string>;
}

export interface CameraUiBuildOptions {
  rootDir?: string;
  input?: string | string[];
  mode?: 'development' | 'production';
  additionalFiles?: string[] | { source: string; target: string }[];
  external?: (string | RegExp)[];
  language?: PluginLanguage;
  go?: GoBuildOptions;
}

export type PluginRole = 'provider' | 'consumer' | 'both';

export interface CreateOptions {
  displayName: string;
  language: PluginLanguage;
  pythonVersion?: PythonVersion;
  quality: boolean;
  role: PluginRole;
  provides: SensorType[];
  consumes: SensorType[];
}

export interface PublishOptions {
  alpha?: boolean;
  beta?: boolean;
  latest?: boolean;
  yes?: boolean;
  provenance?: boolean;
}
