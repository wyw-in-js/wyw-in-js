#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { cwd, exit } from 'node:process';

import { globSync } from 'glob';
import { transformSync } from 'oxc-transform';

const DEFAULT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const KNOWN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.txt',
  '.md',
  '.wasm',
  '.node',
]);

const args = parseArgs(process.argv.slice(2));
const packageRoot = cwd();
const packageJson = readPackageJson(packageRoot);
const srcDir = path.resolve(packageRoot, args.srcDir ?? 'src');
const outDir = path.resolve(packageRoot, args.outDir ?? 'esm');
const outputExtension =
  args.outFileExtension ?? inferOutputExtension(packageRoot, packageJson);
const ignoredFiles = [
  '**/__tests__/**',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.ts',
  '**/*.test.tsx',
  ...readPackageBuildIgnores(packageJson),
  ...(args.ignore ?? []),
];

if (!existsSync(srcDir)) {
  console.error(`Source directory does not exist: ${srcDir}`);
  exit(1);
}

rmSync(outDir, { force: true, recursive: true });

const files = globSync('**/*.{js,jsx,ts,tsx}', {
  absolute: true,
  cwd: srcDir,
  ignore: ignoredFiles,
  nodir: true,
}).sort();

let failed = false;

for (const filename of files) {
  const relative = path.relative(srcDir, filename);
  const outRelative = relative.replace(/\.[^.]+$/, outputExtension);
  const outFilename = path.resolve(outDir, outRelative);
  const source = readFileSync(filename, 'utf8');
  const result = transformSync(filename, source, {
    cwd: packageRoot,
    jsx: {
      runtime: 'classic',
    },
    lang: getLang(filename),
    sourceType: 'module',
    sourcemap: true,
    target: 'es2024',
    typescript: {
      allowNamespaces: true,
    },
  });

  if (result.errors.length > 0) {
    failed = true;
    console.error(`Failed to transform ${filename}`);
    for (const error of result.errors) {
      console.error(error.message);
      if (error.codeframe) {
        console.error(error.codeframe);
      }
    }
    continue;
  }

  const rewrittenCode = inlineOxcUsingHelper(
    rewriteRelativeSpecifiers(result.code, filename, outputExtension)
  );
  const map = normalizeSourceMap(result.map, filename, outFilename, source);

  mkdirSync(path.dirname(outFilename), { recursive: true });
  writeFileSync(
    outFilename,
    withSourceMapComment(rewrittenCode, path.basename(outFilename))
  );

  if (map) {
    writeFileSync(`${outFilename}.map`, `${JSON.stringify(map)}\n`);
  }
}

if (failed) {
  exit(1);
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--src-dir') {
      parsed.srcDir = requireValue(arg, next);
      i += 1;
    } else if (arg === '--out-dir') {
      parsed.outDir = requireValue(arg, next);
      i += 1;
    } else if (arg === '--out-file-extension') {
      parsed.outFileExtension = requireValue(arg, next);
      i += 1;
    } else if (arg === '--ignore') {
      parsed.ignore ??= [];
      parsed.ignore.push(requireValue(arg, next));
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(arg, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`);
  }

  return value;
}

function getLang(filename) {
  const ext = path.extname(filename);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.ts') return 'ts';
  if (ext === '.jsx') return 'jsx';
  return 'js';
}

function readPackageJson(root) {
  const packageJsonPath = path.join(root, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function inferOutputExtension(root, packageJson = readPackageJson(root)) {
  try {
    const exportEntry = packageJson?.exports?.['.'];
    const exportDefault = exportEntry?.default || exportEntry?.import;
    const target =
      typeof exportDefault === 'string' ? exportDefault : packageJson?.main;
    return typeof target === 'string' && target.endsWith('.mjs')
      ? '.mjs'
      : '.js';
  } catch {
    return '.js';
  }
}

function readPackageBuildIgnores(packageJson) {
  const ignored = packageJson?.wywBuild?.esm?.ignore;
  return Array.isArray(ignored)
    ? ignored.filter((item) => typeof item === 'string')
    : [];
}

function rewriteRelativeSpecifiers(code, filename, extension) {
  return code
    .replace(
      /(\bimport\s+(?:[^'"]*?\s+from\s*)?)(['"])([^'"\n]+)\2/g,
      (match, prefix, quote, value) =>
        replaceSpecifier(match, prefix, quote, value, filename, extension)
    )
    .replace(
      /(\bexport\s+(?:\*|{[\s\S]*?})\s+from\s*)(['"])([^'"\n]+)\2/g,
      (match, prefix, quote, value) =>
        replaceSpecifier(match, prefix, quote, value, filename, extension)
    )
    .replace(
      /(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g,
      (match, prefix, quote, value) =>
        replaceSpecifier(match, prefix, quote, value, filename, extension)
    );
}

function replaceSpecifier(match, prefix, quote, value, filename, extension) {
  const rewritten = rewriteSpecifier(value, filename, extension);
  if (!rewritten || rewritten === value) {
    return match;
  }

  return `${prefix}${quote}${rewritten}${quote}`;
}

function rewriteSpecifier(value, filename, extension) {
  if (!value || !isRelative(value) || hasQueryOrHash(value)) {
    return null;
  }

  // TypeScript's nodenext resolution requires `.js` specifiers for sibling
  // `.ts` sources; point them at the extension this build emits.
  if (extension !== '.js' && value.endsWith('.js')) {
    const source = path.resolve(path.dirname(filename), value.slice(0, -3));
    if (existsSync(`${source}.ts`) || existsSync(`${source}.tsx`)) {
      return `${value.slice(0, -3)}${extension}`;
    }
  }

  if (hasKnownExtension(value)) {
    return null;
  }

  let rewritten = `${value}${extension}`;
  const baseDir = path.dirname(filename);
  const resolved = path.resolve(baseDir, value);

  try {
    if (resolveWithExtensions(resolved)) {
      rewritten = `${value}${extension}`;
    } else if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      rewritten = `${value.replace(/\/$/, '')}/index${extension}`;
    } else if (resolveIndexWithExtensions(resolved)) {
      rewritten = `${value.replace(/\/$/, '')}/index${extension}`;
    }
  } catch {
    // Keep previous build behavior: fall back to appending the package extension.
  }

  return rewritten;
}

function isRelative(value) {
  return value.startsWith('./') || value.startsWith('../');
}

function hasKnownExtension(value) {
  return KNOWN_EXTS.has(path.extname(value));
}

function hasQueryOrHash(value) {
  return value.includes('?') || value.includes('#');
}

function resolveWithExtensions(basePath) {
  return DEFAULT_EXTS.some((ext) => existsSync(`${basePath}${ext}`));
}

function resolveIndexWithExtensions(basePath) {
  return DEFAULT_EXTS.some((ext) =>
    existsSync(path.join(basePath, `index${ext}`))
  );
}

function inlineOxcUsingHelper(code) {
  return code.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']@oxc-project\/runtime\/helpers\/usingCtx["'];?\n/m,
    (_, helperName) => `${createUsingCtxHelper(helperName)}\n`
  );
}

function createUsingCtxHelper(helperName) {
  return `function ${helperName}(){var r=typeof SuppressedError==="function"?SuppressedError:function(r,e){var n=Error();return n.name="SuppressedError",n.error=r,n.suppressed=e,n},e={},n=[];function using(r,e){if(e!=null){if(Object(e)!==e)throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");if(r)var o=e[Symbol.asyncDispose||Symbol.for("Symbol.asyncDispose")];if(o===void 0&&(o=e[Symbol.dispose||Symbol.for("Symbol.dispose")],r))var t=o;if(typeof o!=="function")throw new TypeError("Object is not disposable.");t&&(o=function(){try{t.call(e)}catch(r){return Promise.reject(r)}}),n.push({v:e,d:o,a:r})}else r&&n.push({d:e,a:r});return e}return{e:e,u:using.bind(null,false),a:using.bind(null,true),d:function(){var o,t=this.e,s=0;function next(){for(;o=n.pop();)try{if(!o.a&&s===1)return s=0,n.push(o),Promise.resolve().then(next);if(o.d){var r=o.d.call(o.v);if(o.a)return s|=2,Promise.resolve(r).then(next,err)}else s|=1}catch(r){return err(r)}if(s===1)return t!==e?Promise.reject(t):Promise.resolve();if(t!==e)throw t}function err(n){return t=t!==e?new r(n,t):n,next()}return next()}}}`;
}

function normalizeSourceMap(map, sourceFilename, outFilename, source) {
  if (!map) {
    return null;
  }

  const sourcePath = toPosix(
    path.relative(path.dirname(outFilename), sourceFilename)
  );

  return {
    ...map,
    file: path.basename(outFilename),
    sources: [sourcePath],
    sourcesContent: [source],
  };
}

function withSourceMapComment(code, basename) {
  const nextCode = code.endsWith('\n') ? code : `${code}\n`;
  return `${nextCode}//# sourceMappingURL=${basename}.map\n`;
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}
