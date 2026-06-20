#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dry = process.argv.includes('--dry');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templates = join(root, 'templates');
const updatesBin = join(root, 'node_modules', '.bin', 'updates');

const { default: config } = await import(join(templates, 'base', 'updates.config.js'));
const exclude = config?.exclude ?? [];

function runUpdates(file, mode) {
  const args = ['-f', file, '-M', mode];
  if (!dry) args.unshift('-u');
  if (exclude.length) args.push('-e', exclude.join(','));
  execFileSync(updatesBin, args, { stdio: 'inherit', cwd: root });
}

for (const [rel, mode] of [
  ['base/package.json', 'npm'],
  ['go/go.mod', 'go'],
]) {
  console.log(`\n▸ ${rel}`);
  runUpdates(join(templates, rel), mode);
}

for (const rel of ['base/package.eslint.json', 'base/package.prettier.json', 'typescript/package.json', 'typescript/package.eslint.json']) {
  console.log(`\n▸ ${rel}`);
  const file = join(templates, rel);
  const raw = readFileSync(file, 'utf8');
  const tmp = mkdtempSync(join(tmpdir(), 'cui-tpl-'));
  const tmpPkg = join(tmp, 'package.json');
  writeFileSync(tmpPkg, JSON.stringify({ name: 'tpl', version: '0.0.0', dependencies: JSON.parse(raw) }, null, 2));

  try {
    runUpdates(tmpPkg, 'npm');
    if (!dry) {
      const updated = JSON.parse(readFileSync(tmpPkg, 'utf8')).dependencies;
      writeFileSync(file, JSON.stringify(updated, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function pypiLatest(name) {
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (!res.ok) return null;
    return (await res.json())?.info?.version ?? null;
  } catch {
    return null;
  }
}

for (const rel of ['python/requirements.txt', 'python/requirements.dev.txt']) {
  console.log(`\n▸ ${rel}`);
  const file = join(templates, rel);
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9._-]+)\s*(==)\s*([^\s#;]+)(.*)$/);
    if (!m) continue;
    const [, indent, name, op, cur, rest] = m;
    if (exclude.includes(name)) continue;
    const latest = await pypiLatest(name);
    if (!latest) {
      console.log(`⚠ ${name}: not found on PyPI (skipped)`);
    } else if (latest !== cur) {
      console.log(`${name} ${cur} → ${latest}`);
      lines[i] = `${indent}${name}${op}${latest}${rest}`;
    }
  }

  if (!dry) writeFileSync(file, lines.join('\n'));
}

console.log(dry ? '\n(dry run — no files written)' : '\n✅ template deps updated');
