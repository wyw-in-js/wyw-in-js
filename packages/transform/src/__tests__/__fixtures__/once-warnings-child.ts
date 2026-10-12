/**
 * Runs in a separate process spawned by once-warnings.test.ts, so the
 * once-per-process warning state starts fresh. Prints a JSON report.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  baseHandlers,
  disposeEvalBroker,
  loadWywOptions,
  transform,
  TransformCacheCollection,
} from '../../index';

const processorFile = path.resolve(__dirname, 'test-css-processor.js');

const warnings: string[] = [];
// eslint-disable-next-line no-console
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};

const processWarnings: { code?: string; message: string; name: string }[] = [];
process.on('warning', (warning: Error & { code?: string }) => {
  processWarnings.push({
    code: warning.code,
    message: warning.message,
    name: warning.name,
  });
});

const flushWarnings = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const takeWarnings = () => warnings.splice(0, warnings.length);

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-once-warnings-'))
);

const writeConfig = (name: string, source: string): string => {
  const configFile = path.join(root, name);
  fs.writeFileSync(configFile, source);
  return configFile;
};

const scenario = (
  load: () => unknown
): { result: unknown; warnings: string[] } => {
  const result = load();
  return { result, warnings: takeWarnings() };
};

const runTransform = async (
  customHandlers?: Record<string, unknown>
): Promise<string> => {
  const filename = path.join(root, 'component.js');
  const code = [
    `import { css } from 'test-css-processor';`,
    'export const className = css`color: blue;`;',
  ].join('\n');
  const cache = new TransformCacheCollection();
  try {
    const services = {
      cache,
      options: {
        filename,
        root,
        pluginOptions: {
          configFile: false as const,
          tagResolver: (source: string, tag: string) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
      },
    };
    const asyncResolve = async (what: string) =>
      what === 'test-css-processor' ? processorFile : null;
    const result = customHandlers
      ? await transform(services, code, asyncResolve, customHandlers)
      : await transform(services, code, asyncResolve);
    return `${result.code}\n${result.cssText ?? ''}`;
  } finally {
    disposeEvalBroker(cache);
  }
};

const main = async () => {
  try {
    const plainConfig = writeConfig(
      'plain.config.cjs',
      'module.exports = { displayName: true };\n'
    );
    const rulesConfig = writeConfig(
      'rules.config.cjs',
      [
        'module.exports = {',
        '  rules: [',
        "    { action: 'ignore', test: (filename) => filename.includes('ignored') },",
        "    { action: 'ignore', test: /skipped/ },",
        '  ],',
        '};',
        '',
      ].join('\n')
    );
    const cssConfig = writeConfig(
      'css.config.cjs',
      'module.exports = { prefixer: false, keepComments: true };\n'
    );

    // eval.resolver 'custom' without a custom resolver.
    const customResolverMissing = [
      scenario(() =>
        loadWywOptions({ configFile: false, eval: { resolver: 'custom' } })
      ),
      scenario(() =>
        loadWywOptions({ configFile: false, eval: { resolver: 'custom' } })
      ),
    ].map(({ warnings: reported }) => reported);
    const customResolverSet = scenario(() =>
      loadWywOptions({
        configFile: false,
        eval: { customResolver: async () => null, resolver: 'custom' },
      })
    ).warnings;

    // rules in the config file and in the plugin options. A plugin that
    // loads the config file itself gets rules equal to the config file ones,
    // but with functions of their own.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const configRules = require(rulesConfig).rules;
    delete require.cache[require.resolve(rulesConfig)];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const reloadedRules = require(rulesConfig).rules;
    const sameRules = scenario(() =>
      loadWywOptions({ configFile: rulesConfig, rules: reloadedRules })
    ).warnings;
    const reloadedRulesAreCopies =
      reloadedRules[0].test !== configRules[0].test;
    const pluginRulesOnly = scenario(() =>
      loadWywOptions({ configFile: plainConfig, rules: [{ action: 'ignore' }] })
    ).warnings;
    const conflictingRules = [
      scenario(() =>
        loadWywOptions({
          configFile: rulesConfig,
          rules: [{ action: 'ignore' }],
        })
      ),
      scenario(() =>
        loadWywOptions({
          configFile: rulesConfig,
          rules: [{ action: 'ignore' }],
        })
      ),
    ];
    const conflictUsesConfigRules =
      (conflictingRules[0].result as { rules: unknown[] }).rules.length ===
      configRules.length;

    // CSS options in the config file.
    const cssOptions = [
      scenario(() => loadWywOptions({ configFile: cssConfig })),
      scenario(() => loadWywOptions({ configFile: cssConfig })),
    ].map(({ warnings: reported }) => reported);
    const noCssOptions = scenario(() =>
      loadWywOptions({ configFile: plainConfig })
    ).warnings;

    // customHandlers of transform().
    const withoutHandlers = await runTransform();
    const emptyHandlers = await runTransform({});
    await flushWarnings();
    const afterPlainTransforms = [...processWarnings];
    const withHandlers = await runTransform({
      collect: baseHandlers.collect,
    });
    await runTransform({ collect: baseHandlers.collect });
    await flushWarnings();

    process.stdout.write(
      `${JSON.stringify({
        afterPlainTransforms,
        conflictUsesConfigRules,
        conflictingRules: conflictingRules.map(
          ({ warnings: reported }) => reported
        ),
        cssOptions,
        customHandlerWarnings: processWarnings,
        customResolverMissing,
        customResolverSet,
        emptyHandlersOutputSame: emptyHandlers === withoutHandlers,
        handlersOutputSame: withHandlers === withoutHandlers,
        noCssOptions,
        pluginRulesOnly,
        reloadedRulesAreCopies,
        sameRules,
        unexpected: takeWarnings(),
      })}\n`
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

await main();
