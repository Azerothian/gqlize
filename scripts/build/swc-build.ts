import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/// Run one SWC pass for the package in `cwd`.
///
/// The flags used to live in nine copies of the same `package.json` script,
/// including this one verbatim:
///
///     swc src --out-dir publish/lib --out-file-extension mjs \
///       --strip-leading-paths -s --ignore "**/*.d.ts"
///
/// and the SWC config itself lived in eighteen per-package `.swcrc` /
/// `.swcrc-cjs` files, sixteen of which were identical. Both now have one home:
/// the flags here, the config in `swcrc.base.json` / `swcrc-cjs.base.json` at
/// the repo root.
///
/// SWC has no `extends` in `.swcrc` — it rejects the key outright, listing the
/// fields it does accept — so a shared config is reached with `--config-file`,
/// which is the mechanism the CJS build already used.
///
/// A package that needs different settings keeps its own `.swcrc` /
/// `.swcrc-cjs` and it wins: `nestize` does, for legacy decorators. That is why
/// the override is detected by file existence rather than listed here — the
/// exception lives next to the package it belongs to.

type Target = 'esm' | 'cjs';

const TARGETS: Record<Target, { outDir: string; base: string; local: string; extraArgs: string[] }> = {
  esm: {
    outDir: 'publish/lib',
    base: 'swcrc.base.json',
    local: '.swcrc',
    extraArgs: ['--out-file-extension', 'mjs'],
  },
  cjs: {
    outDir: 'publish/cjs',
    base: 'swcrc-cjs.base.json',
    local: '.swcrc-cjs',
    extraArgs: [],
  },
};

const target = process.argv[2] as Target;
if (!TARGETS[target]) {
  throw new Error(`swc-build: expected "esm" or "cjs", got ${JSON.stringify(process.argv[2])}`);
}
const { outDir, base, local, extraArgs } = TARGETS[target];

const repoRoot = path.resolve(import.meta.dirname, '../..');
const configFile = fs.existsSync(path.resolve(process.cwd(), local))
  ? path.resolve(process.cwd(), local)
  : path.resolve(repoRoot, base);

execFileSync(
  'swc',
  [
    'src',
    '--out-dir', outDir,
    '--config-file', configFile,
    '--strip-leading-paths',
    '-s',
    '--ignore', '**/*.d.ts',
    ...extraArgs,
  ],
  { stdio: 'inherit' },
);
