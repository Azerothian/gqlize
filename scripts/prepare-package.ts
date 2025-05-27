import { globby } from 'globby';
import fs from "node:fs/promises";
import path from "node:path";

/// create a function that uses globby to find all files in the src directory and updates the package.json file 
/// to add import and require statements for each file found to the exports section of the package.json file



async function updatePackageJson() {
  await fs.mkdir(path.join(process.cwd(), './publish'), { recursive: true });
  const files = await globby(['**/*'], {
    // expandDirectories: true,
    onlyDirectories: false,
    onlyFiles: true,
    cwd: path.resolve(process.cwd(), 'src'),
    // absolute: true,
  });
  const packageJsonPath = path.join(process.cwd(), './package.json');
  const packagePublishJsonPath = path.join(process.cwd(), './publish/package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
  const exports = {
    ".": {
      "import": "./lib/index.mjs",
      "require": "./cjs/index.js",
      "types": "./types/index.d.ts",
    }
  };
  for (const file of files) {
    let fileName = path.basename(file, '.ts');


    // const dir = path.relative(path.resolve(process.cwd(), "./src"), path.dirname(file));
    let dir = path.dirname(file);
    if (dir === '.') {
      dir = '';
    } else {
      dir += '/';
    }
    if (fileName.match(/\.d$/)) {
      fileName = fileName.replace(/\.d$/, '');
      exports[`./${dir}${fileName}`] = {
        "types": `./types/${dir}${fileName}.d.ts`,
      };
    } else {
      exports[`./${dir}${fileName}`] = {
        "import": `./lib/${dir}${fileName}.mjs`,
        "require": `./cjs/${dir}${fileName}.js`,
        "types": `./types/${dir}${fileName}.d.ts`,
      };
    }
  }
  packageJson.exports = exports;
  delete packageJson.devDependencies;
  delete packageJson.scripts;

  await fs.writeFile(packagePublishJsonPath, JSON.stringify(packageJson, null, 2));
}
updatePackageJson()