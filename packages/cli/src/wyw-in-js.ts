/* eslint-disable no-console */
/**
 * This file contains a CLI for wyw-in-js.
 */

import fs from 'fs';
import path from 'path';

import { asyncResolveFallback } from '@wyw-in-js/shared';
import {
  createFileReporter,
  createParallelTransforms,
  disposeEvalBroker,
  TransformCacheCollection,
  transform,
} from '@wyw-in-js/transform';
import { globSync } from 'glob';
import mkdirp from 'mkdirp';
import normalize from 'normalize-path';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import { reportTransformDiagnostics } from './diagnostics';
import { createMetadataFile } from './metadata';

const modulesOptions = [
  'commonjs',
  'es2015',
  'es6',
  'esnext',
  'native',
] as const;

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options] <files ...>')
  .option('config', {
    alias: 'c',
    type: 'string',
    description: 'Path to a config file',
    requiresArg: true,
    coerce: path.resolve,
  })
  .option('debug', {
    alias: 'd',
    type: 'string',
    description: 'Path for debug output',
    coerce: path.resolve,
  })
  .option('out-dir', {
    alias: 'o',
    type: 'string',
    description: 'Output directory for the extracted CSS files',
    demandOption: true,
    requiresArg: true,
    coerce: path.resolve,
  })
  .option('source-maps', {
    alias: 's',
    type: 'boolean',
    description: 'Generate source maps for the CSS files',
    default: false,
  })
  .option('parallel', {
    alias: 'p',
    type: 'boolean',
    description: 'Run extraction in parallel',
    default: false,
  })
  .option('workers', {
    type: 'number',
    description:
      'Number of worker threads for extraction (implies --parallel); 0 runs extraction on the main thread',
    requiresArg: true,
  })
  .option('output-metadata', {
    type: 'boolean',
    description:
      'Emit sidecar .wyw-in-js.json metadata manifests for transformed files',
  })
  .option('source-root', {
    alias: 'r',
    type: 'string',
    description: 'Directory containing the source JS files',
    demandOption: true,
    requiresArg: true,
    coerce: path.resolve,
  })
  .option('insert-css-requires', {
    alias: 'i',
    type: 'string',
    description:
      'Directory containing JS files to insert require statements for the CSS files',
    requiresArg: true,
    coerce: path.resolve,
  })
  .option('transform', {
    alias: 't',
    type: 'boolean',
    description: 'Replace template tags with evaluated values',
  })
  .option('modules', {
    alias: 'm',
    choices: modulesOptions,
    description: 'Specifies a type of used imports',
    default: 'commonjs' as const,
    coerce: (s) => s.toLowerCase(),
  })
  .implies('insert-css-requires', 'source-root')
  .implies('transform', 'insert-css-requires')
  .option('ignore', {
    alias: 'x',
    type: 'string',
    description: 'Pattern of files to ignore. Be sure to provide a string',
    requiresArg: true,
  })
  .alias('help', 'h')
  .alias('version', 'v')
  .parseSync();

type Options = {
  configFile?: string;
  debug?: string;
  ignore?: string;
  insertCssRequires?: string;
  modules: (typeof modulesOptions)[number];
  outDir: string;
  outputMetadata?: boolean;
  parallel?: boolean;
  sourceMaps?: boolean;
  sourceRoot: string;
  transform?: boolean;
  workers?: number;
};

function resolveRequireInsertionFilename(filename: string) {
  return filename.replace(/\.tsx?/, '.js');
}

function resolveOutputFilename(
  filename: string,
  outDir: string,
  sourceRoot: string
) {
  const outputFolder = path.relative(sourceRoot, path.dirname(filename));
  const outputBasename = path
    .basename(filename)
    .replace(path.extname(filename), '.css');

  return path.join(outDir, outputFolder, outputBasename);
}

async function processFiles(files: (number | string)[], options: Options) {
  const { emitter, onDone } = createFileReporter(
    options.debug ? { dir: options.debug, print: true } : false
  );

  const resolvedFiles = files.reduce(
    (acc, pattern) => [
      ...acc,
      ...globSync(pattern.toString(), {
        absolute: true,
        ignore: options.ignore,
      }),
    ],
    [] as string[]
  );
  const cache = new TransformCacheCollection();
  // One object for all files: transform() memoizes options by identity.
  const pluginOptions = {
    configFile: options.configFile,
    outputMetadata: options.outputMetadata,
  };
  const parallelTransforms = createParallelTransforms({
    onFallback: (message) => console.warn(`[wyw-in-js] ${message}`),
    parallel: options.workers,
    unsupported: options.debug ? 'the `--debug` option is set' : null,
  });
  const workerScope =
    parallelTransforms?.scope('cli', () => ({
      asyncResolveKey: 'cli',
      pluginOptions,
      root: options.sourceRoot,
    })) ?? null;

  const modifiedFiles: { content: string; name: string }[] = [];

  const tasks: (() => Promise<boolean>)[] = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const filename of resolvedFiles) {
    if (fs.lstatSync(filename).isDirectory()) {
      return;
    }

    const outputFilename = resolveOutputFilename(
      filename,
      options.outDir,
      options.sourceRoot
    );

    const transformServices = {
      options: {
        filename,
        outputFilename,
        pluginOptions,
        root: options.sourceRoot,
      },
      cache,
      eventEmitter: emitter,
    };

    const run = (code: string) =>
      workerScope
        ? workerScope.transform({
            asyncResolve: asyncResolveFallback,
            code,
            filename,
            outputFilename,
          })
        : transform(transformServices, code, asyncResolveFallback);

    tasks.push(() =>
      run(fs.readFileSync(filename).toString()).then(
        ({
          code,
          cssText,
          diagnostics,
          metadata,
          sourceMap,
          cssSourceMapText,
        }): boolean => {
          if (diagnostics?.length) {
            reportTransformDiagnostics(diagnostics);
          }

          const shouldWriteCss =
            typeof cssText === 'string' && cssText.length > 0;

          if (!shouldWriteCss && !metadata) {
            return false;
          }

          mkdirp.sync(path.dirname(outputFilename));

          if (metadata) {
            const metadataFile = createMetadataFile({
              cssFile: shouldWriteCss ? outputFilename : undefined,
              metadata,
              outputRoot: options.outDir,
              outputFilename,
              sourceRoot: options.sourceRoot,
              sourceFilename: filename,
            });

            fs.writeFileSync(metadataFile.filename, metadataFile.content);
          }

          if (!shouldWriteCss) {
            return false;
          }

          const cssContent =
            options.sourceMaps && sourceMap
              ? `${cssText}\n/*# sourceMappingURL=${outputFilename}.map */`
              : cssText;

          fs.writeFileSync(outputFilename, cssContent);

          if (
            options.sourceMaps &&
            sourceMap &&
            typeof cssSourceMapText !== 'undefined'
          ) {
            fs.writeFileSync(`${outputFilename}.map`, cssSourceMapText);
          }

          if (options.sourceRoot && options.insertCssRequires) {
            const inputFilename = path.resolve(
              options.insertCssRequires,
              path.relative(options.sourceRoot, filename)
            );

            const relativePath = normalize(
              path.relative(path.dirname(inputFilename), outputFilename)
            );

            const pathForImport = relativePath.startsWith('.')
              ? relativePath
              : `./${relativePath}`;

            const statement =
              options.modules === 'commonjs'
                ? `\nrequire('${pathForImport}');`
                : `\nimport "${pathForImport}";`;

            const normalizedInputFilename =
              resolveRequireInsertionFilename(inputFilename);

            const inputContent = options.transform
              ? code
              : fs.readFileSync(normalizedInputFilename, 'utf-8');

            if (!inputContent.trim().endsWith(statement)) {
              modifiedFiles.push({
                name: normalizedInputFilename,
                content: `${inputContent}\n${statement}\n`,
              });
            }
          }

          return true;
        }
      )
    );
  }

  try {
    if (options.parallel || workerScope) {
      const res = await Promise.all(tasks.map((task) => task()));
      console.log(
        `Successfully extracted ${res.filter((i) => i).length} CSS files.`
      );
    } else {
      let count = 0;
      for (const task of tasks) {
        // eslint-disable-next-line no-await-in-loop
        const res = await task();
        if (res) {
          count += 1;
        }
      }

      console.log(`Successfully extracted ${count} CSS files.`);
    }

    modifiedFiles.forEach(({ name, content }) => {
      fs.writeFileSync(name, content);
    });

    onDone(options.sourceRoot ?? process.cwd());
  } finally {
    await parallelTransforms?.dispose();
    disposeEvalBroker(cache);
    cache.clear('all');
    modifiedFiles.length = 0;
    resolvedFiles.length = 0;
    tasks.length = 0;
  }
}

processFiles(argv._, {
  configFile: argv.config,
  debug: argv.debug,
  ignore: argv.ignore,
  insertCssRequires: argv['insert-css-requires'],
  modules: argv.modules,
  parallel: argv.parallel,
  outDir: argv['out-dir'],
  outputMetadata: argv['output-metadata'],
  sourceMaps: argv['source-maps'],
  sourceRoot: argv['source-root'],
  transform: argv.transform,
  workers: argv.workers,
});
