import fs from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';

/// Post-process the SWC ESM output (publish/lib/**/*.mjs). SWC's
/// `--out-file-extension mjs` renames files but leaves relative import/export
/// specifiers extensionless, which Node's ESM resolver rejects. Rewrite each
/// relative specifier to its emitted target: `<x>.mjs` for a file, or
/// `<x>/index.mjs` for a directory. Bare specifiers (workspace packages,
/// graphql, sequelize, ...) are left untouched so they resolve via node_modules
/// and chain into each sibling's own `import` condition.

const libDir = path.resolve(process.cwd(), 'publish/lib');

function resolveSpecifier(fromFile: string, spec: string): string {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return spec; // bare
  if (/\.(mjs|js|cjs|json)$/.test(spec)) return spec; // already explicit
  const baseDir = path.dirname(fromFile);
  if (fs.existsSync(path.resolve(baseDir, `${spec}.mjs`))) {
    return `${spec}.mjs`;
  }
  if (fs.existsSync(path.resolve(baseDir, spec, 'index.mjs'))) {
    return spec.endsWith('/') ? `${spec}index.mjs` : `${spec}/index.mjs`;
  }
  return spec; // unresolved relative — leave as-is
}

// Contexts that carry a module specifier in ESM output:
//  - `... from '<spec>'`  (import/export ... from)
//  - `import('<spec>')`   (dynamic import)
//  - `import '<spec>'`    (side-effect import)
const patterns: RegExp[] = [
  /(\bfrom\s*)(['"])(\.[^'"]*)\2/g,
  /(\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g,
  /(\bimport\s+)(['"])(\.[^'"]*)\2/g,
];

async function run() {
  const files: string[] = [];
  for await (const match of glob('**/*.mjs', { cwd: libDir })) {
    files.push(path.resolve(libDir, match));
  }
  for (const file of files) {
    let src = fs.readFileSync(file, 'utf8');
    let changed = false;
    for (const re of patterns) {
      src = src.replace(re, (_m, pre, quote, spec) => {
        const next = resolveSpecifier(file, spec);
        if (next !== spec) changed = true;
        return `${pre}${quote}${next}${quote}`;
      });
    }
    if (changed) fs.writeFileSync(file, src);
  }
}
run();
