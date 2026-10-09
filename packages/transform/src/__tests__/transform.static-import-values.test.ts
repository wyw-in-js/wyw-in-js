import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker, EvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type { PluginOptions } from '../types';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');
const styledProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-styled-processor.js'
);
const staticContractCssProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-static-contract-css-processor.js'
);
const runtimeStyledProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-runtime-styled-processor.js'
);
const unsafeSnapshotMessage =
  'local snapshot depends on executed side effects that cannot be safely hoisted';

const createResolver =
  (processorPath: string) => async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorPath;
    }

    if (what === 'test-styled-processor') {
      return styledProcessorFile;
    }

    if (what === 'test-static-contract-css-processor') {
      return staticContractCssProcessorFile;
    }

    if (what === 'test-runtime-styled-processor') {
      return runtimeStyledProcessorFile;
    }

    if (what.startsWith('.')) {
      return resolve(dirname(importer), what);
    }

    return null;
  };

const runTransformWithOptions = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  eventEmitter?: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {},
  asyncResolve = createResolver(processorFile)
) =>
  transform(
    {
      cache,
      eventEmitter,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          ...pluginOptions,
          tagResolver: (source, tag) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            if (source === 'test-styled-processor' && tag === 'styled') {
              return styledProcessorFile;
            }

            if (
              source === 'test-static-contract-css-processor' &&
              tag === 'css'
            ) {
              return staticContractCssProcessorFile;
            }

            if (
              source === 'test-runtime-styled-processor' &&
              tag === 'styled'
            ) {
              return runtimeStyledProcessorFile;
            }

            return null;
          },
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    asyncResolve
  );

const runTransform = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  eventEmitter?: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {},
  asyncResolve = createResolver(processorFile)
) =>
  runTransformWithOptions(
    root,
    entryFile,
    cache,
    eventEmitter,
    {
      ...pluginOptions,
      eval: {
        strategy: 'hybrid',
        ...pluginOptions.eval,
      },
      features: pluginOptions.features,
    },
    asyncResolve
  );

const createPackageResolver =
  (root: string) => async (what: string, importer: string) => {
    if (what.startsWith('.')) {
      return resolve(dirname(importer), what);
    }

    const packageMain = join(root, 'node_modules', what, 'index.js');
    if (existsSync(packageMain)) {
      return packageMain;
    }

    return null;
  };

const runTransformWithPackageLookup = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  eventEmitter?: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {}
) =>
  transform(
    {
      cache,
      eventEmitter,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          ...pluginOptions,
          eval: {
            strategy: 'hybrid',
            ...pluginOptions.eval,
          },
          features: pluginOptions.features,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    createPackageResolver(root)
  );

const writeJson = (filename: string, value: unknown): void => {
  writeFileSync(filename, JSON.stringify(value, null, 2));
};

const writeProcessorPackage = (
  root: string,
  {
    implementationSource,
    packageName,
    semantics,
    tagName,
  }: {
    implementationSource: string;
    packageName: string;
    semantics?: unknown;
    tagName: string;
  }
): void => {
  const packageRoot = join(root, 'node_modules', packageName);
  const distRoot = join(packageRoot, 'dist');
  const processorFileName = `${tagName}-processor.js`;
  const manifestFileName = `${tagName}.processor.json`;

  mkdirSync(distRoot, { recursive: true });
  writeJson(join(packageRoot, 'package.json'), {
    name: packageName,
    main: './index.js',
    'wyw-in-js': {
      tags: {
        [tagName]:
          semantics === undefined
            ? `./dist/${processorFileName}`
            : `./dist/${manifestFileName}`,
      },
    },
  });
  writeFileSync(join(packageRoot, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(distRoot, processorFileName), implementationSource);

  if (semantics !== undefined) {
    writeJson(join(distRoot, manifestFileName), {
      version: 1,
      name: packageName,
      implementation: `./${processorFileName}`,
      tags: [tagName],
      semantics,
    });
  }
};

const createFixtureProcessorPackage = (
  root: string,
  options: {
    packageName: string;
    processorPath: string;
    semantics?: unknown;
    tagName: string;
  }
): void =>
  writeProcessorPackage(root, {
    implementationSource: `module.exports = require(${JSON.stringify(
      options.processorPath
    )});\n`,
    packageName: options.packageName,
    semantics: options.semantics,
    tagName: options.tagName,
  });

const manifestOnlyCssProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { TaggedTemplateProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  class ManifestOnlyCssProcessor extends TaggedTemplateProcessor {
    get asSelector() {
      return this.className;
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__manifestOnlyClassName'),
        []
      );
    }

    addInterpolation(_node, _precedingCss, source) {
      throw new Error(
        \`css tag cannot handle '\${source}' as an interpolated value\`
      );
    }

    doEvaltimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.className), false);
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.className), false);
    }

    extractRules(_valueCache, cssText, loc) {
      const selector = \`.\${this.className}\`;

      return {
        [selector]: {
          cssText,
          className: this.className,
          displayName: this.displayName,
          start: loc?.start ?? null,
        },
      };
    }
  }

  module.exports = { default: ManifestOnlyCssProcessor };
`;

const cssTemplateSemantics = {
  kind: 'css-template',
  outputs: ['class-name', 'css-text'],
  runtimeDependencies: 'explicit',
  staticInterpolations: ['serializable', 'class-name', 'selector-chain'],
};

const styledTargetSemantics = {
  kind: 'styled-target',
  targets: ['class-name', 'selector-chain', 'opaque-component'],
};

const dxStyleObjectCallSemantics = {
  kind: 'style-object-call',
};

const dxCssVarCallSemantics = {
  kind: 'css-var-call',
};

const dxTokenContractCallSemantics = {
  kind: 'token-contract-call',
};

const dxClassNameCallSemantics = {
  kind: 'class-name-call',
};

const manifestOnlyStyleCallProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  const descriptorKey = '__dxStyles';

  const getCallExpressions = (params) => {
    const callParam = params.find((param) => param[0] === 'call');
    return callParam ? callParam.slice(1) : [];
  };

  const valueFromCache = (expression, values) => {
    if (expression.kind === 2) {
      return expression.value;
    }
    return values.get(expression.ex.name);
  };

  const classNameFromStyleHandle = (value) => {
    const descriptor = value && typeof value === 'object' ? value[descriptorKey] : null;
    return descriptor &&
      descriptor.kind === 'styleHandle' &&
      typeof descriptor.className === 'string'
      ? descriptor.className
      : null;
  };

  const hasStyleEntries = (style) =>
    style && typeof style === 'object' && !Array.isArray(style) && Object.keys(style).length > 0;

  class ManifestOnlyStyleCallProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
      this.expressions = getCallExpressions(params);
      this.dependencies.push(
        ...this.expressions.filter((expression) => expression.ex.type === 'Identifier')
      );
      this.runtimeClassName = this.className;
    }

    get asSelector() {
      return \`.\${this.runtimeClassName}\`;
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__manifestOnlyStyleCall'),
        this.expressions.map((expression) => expression.ex)
      );
    }

    build(values) {
      const parts = this.expressions.map((expression) => valueFromCache(expression, values));
      const styleHandleClassNames = parts
        .map(classNameFromStyleHandle)
        .filter((className) => className !== null);
      const hasLocalStyle = parts.some((part) => hasStyleEntries(part));
      this.runtimeClassName = [
        ...styleHandleClassNames,
        hasLocalStyle || styleHandleClassNames.length === 0 ? this.className : undefined,
      ].filter(Boolean).join(' ');
    }

    doEvaltimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.className), false);
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.runtimeClassName), false);
    }
  }

  module.exports = { default: ManifestOnlyStyleCallProcessor };
`;

const manifestOnlyCreateVarProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  class ManifestOnlyCreateVarProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
    }

    get asSelector() {
      return this.toValueForm();
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__manifestOnlyCreateVar'),
        []
      );
    }

    build() {}

    doEvaltimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.toValueForm()), false);
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.toValueForm()), false);
    }

    toValueForm() {
      return \`var(--\${this.className})\`;
    }
  }

  module.exports = { default: ManifestOnlyCreateVarProcessor };
`;

const manifestOnlyTokenContractProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  class ManifestOnlyTokenContractProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
      this.expressions = params.find((param) => param[0] === 'call')?.slice(1) ?? [];
      this.dependencies.push(
        ...this.expressions.filter((expression) => expression.ex.type === 'Identifier')
      );
    }

    get asSelector() {
      return \`.\${this.className}\`;
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__manifestOnlyTokenContract'),
        []
      );
    }

    build() {}

    doEvaltimeReplacement() {
      this.replacer(() => this.value, false);
    }

    doRuntimeReplacement() {
      this.replacer(() => this.value, false);
    }
  }

  module.exports = { default: ManifestOnlyTokenContractProcessor };
`;

const dxLikeTokenContractProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  const getCallExpressions = (params) => {
    const callParam = params.find((param) => param[0] === 'call');
    return callParam ? callParam.slice(1) : [];
  };

  const valueFromCache = (expression, values) => {
    if (expression.kind === 2) {
      return expression.value;
    }
    return values.get(expression.ex.name);
  };

  const isRecord = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  const buildContractLeafName = (prefix, path, explicitName) => {
    const leafName =
      explicitName !== null && explicitName.length > 0
        ? explicitName
        : path.join('-');
    return leafName.startsWith('--') ? leafName : '--' + prefix + '-' + leafName;
  };

  const buildTokenContractObject = (shape, prefix, path) => {
    const result = {};
    Object.keys(shape).forEach((key) => {
      const value = shape[key];
      const nextPath = [...path, key];
      result[key] = isRecord(value)
        ? buildTokenContractObject(value, prefix, nextPath)
        : 'var(' + buildContractLeafName(
            prefix,
            nextPath,
            typeof value === 'string' ? value : null
          ) + ')';
    });
    return result;
  };

  const buildTokenContract = (shape, options) => {
    const prefix =
      options && typeof options.prefix === 'string' ? options.prefix.trim() : '';
    if (prefix.length === 0) {
      throw new Error('dx-like createTokenContract() requires a non-empty prefix.');
    }
    if (!isRecord(shape)) {
      throw new Error(
        'dx-like createTokenContract() requires a statically analyzable shape object.'
      );
    }
    return buildTokenContractObject(shape, prefix, []);
  };

  const createValueNode = (astService, value) => {
    if (value === null) {
      return astService.nullLiteral();
    }
    if (typeof value === 'string') {
      return astService.stringLiteral(value);
    }
    if (typeof value === 'number') {
      return astService.numericLiteral(value);
    }
    if (typeof value === 'boolean') {
      return astService.booleanLiteral(value);
    }
    if (Array.isArray(value)) {
      return astService.arrayExpression(
        value.map((item) => createValueNode(astService, item))
      );
    }
    if (isRecord(value)) {
      return astService.objectExpression(
        Object.keys(value).map((key) =>
          astService.objectProperty(
            astService.stringLiteral(key),
            createValueNode(astService, value[key])
          )
        )
      );
    }
    throw new Error('unsupported token contract value');
  };

  class DxLikeTokenContractProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
      this.expressions = getCallExpressions(params);
      this.dependencies.push(
        ...this.expressions.filter((expression) => expression.ex.type === 'Identifier')
      );
      this.contract = null;
    }

    get asSelector() {
      return \`.\${this.className}\`;
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__dxLikePreevalCreateTokenContract'),
        this.expressions.map((expression) => expression.ex)
      );
    }

    build(values) {
      const shape = valueFromCache(this.expressions[0], values);
      const options =
        this.expressions.length < 2
          ? undefined
          : valueFromCache(this.expressions[1], values);
      this.contract = buildTokenContract(shape, options);
    }

    doEvaltimeReplacement() {
      this.replacer(() => this.value, false);
    }

    doRuntimeReplacement() {
      if (this.contract === null) {
        throw new Error('dx-like createTokenContract() contract is not available.');
      }
      this.replacer(() => createValueNode(this.astService, this.contract), false);
    }
  }

  module.exports = { default: DxLikeTokenContractProcessor };
`;

const manifestOnlyClassNameCallProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  class ManifestOnlyClassNameCallProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
    }

    get asSelector() {
      return \`.\${this.className}\`;
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__manifestOnlyClassNameCall'),
        []
      );
    }

    build() {}

    doEvaltimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.className), false);
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.className), false);
    }
  }

  module.exports = { default: ManifestOnlyClassNameCallProcessor };
`;

const evaltimeStaticObjectProcessorSource = dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  const getCallExpressions = (params) => {
    const callParam = params.find((param) => param[0] === 'call');
    return callParam ? callParam.slice(1) : [];
  };

  class EvaltimeStaticObjectProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
      this.expressions = getCallExpressions(params);
      this.dependencies.push(
        ...this.expressions.filter((expression) => expression.ex.type === 'Identifier')
      );
    }

    get value() {
      return this.astService.stringLiteral('evaltime-static-object');
    }

    build() {}

    doEvaltimeReplacement() {
      const [tokens] = this.expressions;
      if (tokens?.kind === 2 && typeof tokens.value === 'object' && tokens.value !== null) {
        throw new Error(
          'cross-file object values must not be coerced to ValueType.CONST'
        );
      }

      this.replacer(this.astService.stringLiteral('evaltime-object-input-ok'), false);
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral('evaltime-static-object'), false);
    }
  }

  module.exports = { default: EvaltimeStaticObjectProcessor };
`;

let processorPackageId = 0;
const nextProcessorPackageName = (prefix: string): string => {
  processorPackageId += 1;
  return `${prefix}-${process.pid}-${processorPackageId}`;
};

const createPerfEventRecorder = () => {
  const counts = new Map<string, number>();
  const events: Record<string, unknown>[] = [];
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'single') {
        events.push(labels);
        return;
      }

      if (type !== 'start' || typeof labels.method !== 'string') {
        return;
      }

      counts.set(labels.method, (counts.get(labels.method) ?? 0) + 1);
    },
    () => 0,
    () => {}
  );

  return { counts, eventEmitter, events };
};

describe('transform static import value inlining', () => {
  it('falls back to eval for ordered writes to a snapshot-local binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        export function Component() {
          let { width } = { width: 1 };
          const className = css\`
            --widths: ${'${width}:${(width = 2)}:${width}'};
          \`;
          return [className, width];
        }
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('--widths:1:2:2');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
      expect(result.code).not.toContain('_snapshot');
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['for-of', '(() => { for (width of [2]) {} return width; })()', '2'],
    [
      'for-in',
      '(() => { for (width in { two: 1 }) {} return width; })()',
      'two',
    ],
  ])(
    'falls back to eval for an eagerly executed snapshot-local %s assignment target',
    async (_name, expression, expectedWidth) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();
      const interpolation = `\${${expression}}`;

      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';

          export function Component() {
            let { width } = { width: 1 };
            const className = css\`
              --width: ${interpolation};
            \`;
            return [className, width];
          }
        `
      );

      try {
        const result = await runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter
        );

        expect(result.cssText).toContain(`--width:${expectedWidth}`);
        expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        expect(result.code).not.toContain('_snapshot');
      } finally {
        disposeEvalBroker(cache);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('keeps deferred snapshot-local writes on the strict failure path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `export function Component() {`,
        `  let { width } = { width: 1 };`,
        '  const className = css`--width: ${() => (width = 2)};`;',
        `  return [className, width];`,
        `}`,
      ].join('\n')
    );

    try {
      await expect(runTransform(root, entryFile, cache)).rejects.toThrow(
        unsafeSnapshotMessage
      );
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps deferred snapshot-local reads strict after an eager write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `export function Component() {`,
        `  let { width } = { width: 1 };`,
        '  const className = css`--width: ${(width = 2)}; --callback: ${() => width};`;',
        `  return [className, width];`,
        `}`,
      ].join('\n')
    );

    try {
      await expect(runTransform(root, entryFile, cache)).rejects.toThrow(
        unsafeSnapshotMessage
      );
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines a direct imported literal without keeping the runtime import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.code).not.toContain('./tokens.js');
      expect(result.dependencies).toContain(depFile);
      expect(perf.counts.get('transform:evaluator') ?? 0).toBe(0);
      expect(perf.counts.get('transform:emitCommonJS') ?? 0).toBe(0);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows static strategy when imported values resolve without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          eval: { strategy: 'static' },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(result.code).not.toContain('./tokens.js');
      expect(result.dependencies).toContain(depFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a namespace member after removing component-only hazards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const observerFile = join(root, 'observer.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      observerFile,
      dedent`
        export const observer = (component) => component;
      `
    );
    writeFileSync(
      depFile,
      dedent`
        export const runtime = 'runtime';
        export const smallFontSize = { color: 'red' };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { observer } from './observer.js';
        import * as tokens from './tokens.js';
        import { jsx as _jsx } from 'react/jsx-runtime';

        const Component = observer(() =>
          _jsx('div', { children: tokens.runtime })
        );

        export const className = css\`
          ${'${tokens.smallFontSize}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache, undefined, {
        eval: { strategy: 'static' },
      });

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(depFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported static values by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransformWithOptions(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.code).not.toContain('./tokens.js');
      expect(result.dependencies).toContain(depFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines compiled TypeScript enum exports without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const statusFile = join(root, 'status.js');
    const levelFile = join(root, 'level.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      statusFile,
      dedent`
        var PowerStatus;
        (function (PowerStatus) {
          PowerStatus["UNKNOWN"] = "unknown";
          PowerStatus["POWERED_ON"] = "powered_on";
        })(PowerStatus || (PowerStatus = {}));
        export { PowerStatus as PowerStatus };
        export default PowerStatus;
      `
    );
    writeFileSync(
      levelFile,
      dedent`
        var Level;
        (function (Level) {
          Level[Level["Low"] = 0] = "Low";
          Level[Level["High"] = 2] = "High";
        })(Level || (Level = {}));
        export default Level;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { PowerStatus } from './status.js';
        import Level from './level.js';

        export const className = css\`
          content: "${'${PowerStatus.UNKNOWN}'}";
          z-index: ${'${Level.High}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('content:"unknown"');
      expect(result.cssText).toContain('z-index:2');
      expect(result.dependencies).toContain(statusFile);
      expect(result.dependencies).toContain(levelFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps imported static values in eval when disabled explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          eval: { strategy: 'execute' },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(result.code).not.toContain('./tokens.js');
      expect(result.dependencies).toContain('./tokens.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`resolves complete imported destructuring patterns with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(
        depFile,
        dedent`
          export const fallback = 7;
          export const key = 'height';
          const shared = { value: 1 };
          export const theme = {
            extra: 5,
            first: shared,
            second: shared,
            size: { depth: 9, height: 171, width: 304 },
            tuple: [4, 8, 16],
          };
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { fallback, key, theme } from './tokens.js';

          const {
            size: { width, [key]: height, ...sizeRest },
            tuple: [, gap, ...tail],
            missing = fallback,
            first,
            second,
            ...rest
          } = theme;

          export const className = css\`
            width: ${'${width}'}px;
            height: ${'${height}'}px;
            depth: ${'${sizeRest.depth}'}px;
            gap: ${'${gap}'}px;
            tail: ${'${tail[0]}'}px;
            missing: ${'${missing}'}px;
            extra: ${'${rest.extra}'}px;
            same: ${'${String(first === second)}'};
          \`;
        `
      );

      try {
        const result = await runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        expect(result.cssText).toContain('width:304px');
        expect(result.cssText).toContain('height:171px');
        expect(result.cssText).toContain('depth:9px');
        expect(result.cssText).toContain('gap:8px');
        expect(result.cssText).toContain('tail:16px');
        expect(result.cssText).toContain('missing:7px');
        expect(result.cssText).toContain('extra:5px');
        expect(result.cssText).toContain('same:true');
        expect(result.cssText).not.toContain('width:width:');
        expect(result.dependencies).toContain(depFile);
        expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`does not misfold identity shared across exports with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(
        depFile,
        dedent`
          export const shared = { value: 1 };
          export const source = { selected: shared };
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { shared, source } from './tokens.js';

          const { selected } = source;

          export const className = css\`
            same: ${'${String(selected === shared)}'};
          \`;
        `
      );

      try {
        const transformPromise = runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        if (strategy === 'static') {
          await expect(transformPromise).rejects.toThrow(
            'eval.strategy: "static"'
          );
        } else {
          const result = await transformPromise;
          expect(result.cssText).toContain('same:true');
          expect(result.cssText).not.toContain('same:false');
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`does not use a stale destructured value after a cross-export alias mutation with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(
        depFile,
        dedent`
          export const source = { width: 304 };
          export const alias = source;
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { alias, source } from './tokens.js';

          alias.width = 400;
          const { width } = source;

          export const className = css\`
            width: ${'${width}'}px;
          \`;
        `
      );

      try {
        const transformPromise = runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        if (strategy === 'static') {
          await expect(transformPromise).rejects.toThrow(
            'eval.strategy: "static"'
          );
        } else {
          const result = await transformPromise;
          expect(result.cssText).toContain('width:400px');
          expect(result.cssText).not.toContain('width:304px');
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`does not use a stale value after a destructuring-default alias mutation with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(depFile, `export const source = { width: 304 };`);
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { source } from './tokens.js';

          const alias = source;
          const { selected = alias } = {};
          selected.width = 400;
          const { width } = source;

          export const className = css\`
            width: ${'${width}'}px;
          \`;
        `
      );

      try {
        const transformPromise = runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        if (strategy === 'static') {
          await expect(transformPromise).rejects.toThrow(
            'eval.strategy: "static"'
          );
        } else {
          const result = await transformPromise;
          expect(result.cssText).toContain('width:400px');
          expect(result.cssText).not.toContain('width:304px');
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`does not use a stale direct import after mutation with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(depFile, `export const source = { width: 304 };`);
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { source } from './tokens.js';

          source.width = 400;

          export const className = css\`
            width: ${'${source.width}'}px;
          \`;
        `
      );

      try {
        const transformPromise = runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        if (strategy === 'static') {
          await expect(transformPromise).rejects.toThrow(
            'eval.strategy: "static"'
          );
        } else {
          const result = await transformPromise;
          expect(result.cssText).toContain('width:400px');
          expect(result.cssText).not.toContain('width:304px');
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`does not ignore an opaque imported mutation call with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(
        depFile,
        dedent`
          export const source = { width: 304 };
          export function mutate() {
            source.width = 400;
          }
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { mutate, source } from './tokens.js';

          mutate();
          const { width } = source;

          export const className = css\`
            width: ${'${width}'}px;
          \`;
        `
      );

      try {
        const transformPromise = runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        if (strategy === 'static') {
          await expect(transformPromise).rejects.toThrow(
            'eval.strategy: "static"'
          );
        } else {
          const result = await transformPromise;
          expect(result.cssText).toContain('width:400px');
          expect(result.cssText).not.toContain('width:304px');
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  (
    [
      {
        factory: dedent`
          import { source } from './tokens.js';
          export function mutate() {
            source.width = 400;
          }
        `,
        name: 'a mutator imported from another module',
        setup: dedent`
          import { mutate } from './factory.js';
          mutate();
        `,
      },
      {
        factory: dedent`
          import { source } from './tokens.js';
          export function getSource() {
            return source;
          }
        `,
        name: 'an alias returned from another module',
        setup: dedent`
          import { getSource } from './factory.js';
          const alias = getSource();
          alias.width = 400;
        `,
      },
      {
        factory: `export { source as alias } from './tokens.js';`,
        name: 'an alias re-exported through a barrel',
        setup: dedent`
          import { alias } from './factory.js';
          alias.width = 400;
        `,
      },
    ] as const
  ).forEach(({ factory, name, setup }) => {
    (['hybrid', 'static'] as const).forEach((strategy) => {
      it(`does not detach destructuring from ${name} with ${strategy} evaluation`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
        const entryFile = join(root, 'entry.js');
        const factoryFile = join(root, 'factory.js');
        const tokensFile = join(root, 'tokens.js');
        const cache = new TransformCacheCollection();
        const perf = createPerfEventRecorder();

        writeFileSync(tokensFile, `export const source = { width: 304 };`);
        writeFileSync(factoryFile, factory);
        writeFileSync(
          entryFile,
          dedent`
            import { css } from 'test-css-processor';
            import { source } from './tokens.js';
            ${setup}

            const { width } = source;
            export const className = css\`
              width: ${'${width}'}px;
            \`;
          `
        );

        try {
          const transformPromise = runTransform(
            root,
            entryFile,
            cache,
            perf.eventEmitter,
            {
              eval: { strategy },
            }
          );

          if (strategy === 'static') {
            await expect(transformPromise).rejects.toThrow(
              'eval.strategy: "static"'
            );
          } else {
            const result = await transformPromise;
            expect(result.cssText).toContain('width:400px');
            expect(result.cssText).not.toContain('width:304px');
            expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(
              0
            );
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  });

  (
    [
      {
        name: 'a direct local alias',
        setup: dedent`
          const source = { width: 304 };
          const alias = source;
          alias.width = 400;
        `,
      },
      {
        name: 'a class static field',
        setup: dedent`
          const source = { width: 304 };
          class Holder {
            static value = source;
          }
          Holder.value.width = 400;
        `,
      },
      {
        name: 'an invoked parameter default',
        setup: dedent`
          const source = { width: 304 };
          ((value = source) => {
            value.width = 400;
          })();
        `,
      },
      {
        name: 'a for-of binding default',
        setup: dedent`
          const source = { width: 304 };
          for (const { value = source } of [{}]) {
            value.width = 400;
          }
        `,
      },
    ] as const
  ).forEach(({ name, setup }) => {
    (['hybrid', 'static'] as const).forEach((strategy) => {
      it(`preserves ${name} while extracting from a function with ${strategy} evaluation`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
        const entryFile = join(root, 'entry.js');
        const cache = new TransformCacheCollection();
        const perf = createPerfEventRecorder();

        writeFileSync(
          entryFile,
          dedent`
            import { css } from 'test-css-processor';

            function makeClassName() {
              ${setup}
              const { width } = source;
              return css\`
                width: ${'${width}'}px;
              \`;
            }

            export const className = makeClassName();
          `
        );

        try {
          const transformPromise = runTransform(
            root,
            entryFile,
            cache,
            perf.eventEmitter,
            {
              eval: { strategy },
            }
          );

          if (strategy === 'static') {
            await expect(transformPromise).rejects.toThrow(
              'eval.strategy: "static"'
            );
          } else {
            const result = await transformPromise;
            expect(result.cssText).toContain('width:400px');
            expect(result.cssText).not.toContain('width:304px');
            expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(
              0
            );
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  });

  (['hybrid', 'static'] as const).forEach((strategy) => {
    it(`does not use a stale destructuring snapshot after Object.assign with ${strategy} evaluation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const depFile = join(root, 'tokens.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(depFile, `export const theme = { size: { width: 304 } };`);
      writeFileSync(
        entryFile,
        dedent`
          import { css } from 'test-css-processor';
          import { theme } from './tokens.js';

          Object.assign(theme.size, { width: 400 });
          const { size: { width } } = theme;

          export const className = css\`
            width: ${'${width}'}px;
          \`;
        `
      );

      try {
        const transformPromise = runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          {
            eval: { strategy },
          }
        );

        if (strategy === 'static') {
          await expect(transformPromise).rejects.toThrow(
            'eval.strategy: "static"'
          );
        } else {
          const result = await transformPromise;
          expect(result.cssText).toContain('width:400px');
          expect(result.cssText).not.toContain('width:304px');
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('keeps local static values in eval when disabled explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const color = 'red';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          eval: { strategy: 'execute' },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves literals through explicit re-export chains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();

    writeFileSync(depFile, `export const spacing = [4, 8];`);
    writeFileSync(barrelFile, `export { spacing } from './tokens.js';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { spacing } from './barrel.js';

        export const className = css\`
          margin: ${'${spacing[1]}'}px;
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('margin:8px');
      expect(result.code).not.toContain('./barrel.js');
      expect(result.dependencies).toEqual(
        expect.arrayContaining([barrelFile, depFile])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported fixed objects for CSS object interpolation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'theme.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        export const rules = {
          color: 'red',
          display: 'block',
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { rules } from './theme.js';

        export const className = css\`
          ${'${rules}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('display:block');
      expect(result.code).not.toContain('./theme.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines safe exports from modules with function declarations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'theme.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        export function formatColor(value) {
          return String(value);
        }

        export const rules = {
          color: 'red',
          display: 'block',
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { rules } from './theme.js';

        export const className = css\`
          ${'${rules}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('display:block');
      expect(result.code).not.toContain('./theme.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported zero-arg helper calls with static return values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const helperFile = join(root, 'helper.js');
    const tokensFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      tokensFile,
      dedent`
        export const sizes = {
          text: {
            fontSize: '18px',
          },
        };
        export const MOBILE = 'screen and (max-width: 768px)';
      `
    );
    writeFileSync(
      helperFile,
      dedent`
        import { MOBILE, sizes } from './tokens.js';

        export const getLabelStyle = () => {
          return \`
            display: flex;
            font-size: ${'${sizes.text.fontSize}'};

            @media ${'${MOBILE}'} {
              display: block;
            }
          \`;
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { getLabelStyle } from './helper.js';

        export const className = css\`
          ${'${getLabelStyle()}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('display:flex');
      expect(result.cssText).toContain('font-size:18px');
      expect(result.cssText).toContain('@media screen and (max-width: 768px)');
      expect(result.dependencies).toContain(helperFile);
      expect(result.dependencies).toContain(tokensFile);
      expect(result.code).not.toContain('./helper.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps imported zero-arg helpers in eval for bare function references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const helperFile = join(root, 'helper.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      helperFile,
      dedent`
        export const getColor = () => 'red';
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { getColor } from './helper.js';

        export const className = css\`
          color: ${'${getColor}'};
        \`;
      `
    );

    try {
      await expect(
        runTransform(root, entryFile, cache, perf.eventEmitter)
      ).rejects.toThrow("css tag cannot handle 'getColor'");
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval for unsafe dependency modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const color = String('red');
        export { color };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses bundler-loaded dependency code before falling back to filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-bundler-loaded-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        const color = (() => {
          throw new Error('raw dependency from fs was evaluated');
        })();
        export { color };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await transform(
        {
          cache,
          loadDependencyCode: async (resolved: string) => {
            if (resolved === depFile) {
              return "export const color = 'red';";
            }

            return undefined;
          },
          options: {
            filename: entryFile,
            root,
            pluginOptions: {
              configFile: false,
              tagResolver: (source, tag) => {
                if (source === 'test-css-processor' && tag === 'css') {
                  return processorFile;
                }

                return null;
              },
            },
          },
        } as Parameters<typeof transform>[0],
        readFileSync(entryFile, 'utf8'),
        createResolver(processorFile)
      );

      expect(result.cssText).toContain('color:red');
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to filesystem dependency code when bundler loading fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-bundler-loaded-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        const color = String('red');
        export { color };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await transform(
        {
          cache,
          loadDependencyCode: async () => {
            throw new Error('bundler load failed');
          },
          options: {
            filename: entryFile,
            root,
            pluginOptions: {
              configFile: false,
              tagResolver: (source, tag) => {
                if (source === 'test-css-processor' && tag === 'css') {
                  return processorFile;
                }

                return null;
              },
            },
          },
        } as Parameters<typeof transform>[0],
        readFileSync(entryFile, 'utf8'),
        createResolver(processorFile)
      );

      expect(result.cssText).toContain('color:red');
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe dependency modules when eval.strategy is static', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        export const color = Date.now() > 0 ? 'red' : 'blue';
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      await expect(
        runTransform(root, entryFile, cache, undefined, {
          eval: { strategy: 'static' },
        })
      ).rejects.toThrow('eval.strategy: "static"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits static resolve debug rejection reasons when eval.strategy enables static resolution', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const color = String('red');
        export { color };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      await runTransform(root, entryFile, cache, perf.eventEmitter);

      expect(
        perf.events.filter((event) => event.type === 'staticResolve')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            exported: 'color',
            filename: depFile,
            phase: 'export',
            reason: 'unsupported-expression',
            status: 'rejected',
          }),
        ])
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps execute values on the evaluator while reporting provenance resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const color = String('red');
        export { color };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransformWithOptions(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          eval: { strategy: 'execute' },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
      expect(
        perf.events.filter((event) => event.type === 'staticResolve')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            exported: 'color',
            filename: depFile,
            phase: 'export',
            reason: 'unsupported-expression',
            status: 'rejected',
          }),
        ])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines safe exports from modules with unrelated unsafe top-level values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const unused = String('side-effect boundary');

        export function formatColor(value) {
          return String(value);
        }

        export const color = 'red';

        void unused;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(depFile);
      expect(result.code).not.toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval when a fixed object is mutated by top-level code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const rules = {
          color: 'red',
        };

        function mutate(value) {
          value.color = 'blue';
        }

        mutate(rules);

        export { rules };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { rules } from './unsafe.js';

        export const className = css\`
          ${'${rules}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:blue');
      expect(result.dependencies).toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes statically resolved imports from modules that still need eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const staticFile = join(root, 'tokens.js');
    const dynamicFile = join(root, 'dynamic.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      staticFile,
      dedent`
        const runtimeOnly = (() => {
          throw new Error('static dependency should not be imported during eval');
        })();

        export const color = 'red';
        export { runtimeOnly };
      `
    );
    writeFileSync(
      dynamicFile,
      dedent`
        export const spacing = Date.now();
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';
        import { spacing } from './dynamic.js';

        export const className = css\`
          color: ${'${color}'};
          margin: ${'${spacing}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(staticFile);
      expect(result.dependencies).toContain('./dynamic.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported selector-only processor class names without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const runtimeOnly = (() => {
          throw new Error('selector-only class should not be imported during eval');
        })();

        export const marker = css\`\`;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(classesFile);
      expect(result.code).not.toContain('./classes.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file selector-only processor class names without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const marker = css\`\`;
        export const runtimeClassName = marker;

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses css-template manifest semantics for same-file class-name inputs before eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const packageName = nextProcessorPackageName('manifest-only-css');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeProcessorPackage(root, {
      implementationSource: manifestOnlyCssProcessorSource,
      packageName,
      semantics: cssTemplateSemantics,
      tagName: 'css',
    });
    writeFileSync(
      entryFile,
      dedent`
        import { css } from '${packageName}';

        const marker = css\`\`;

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransformWithPackageLookup(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps manifest-supported fixtures output-identical to direct JS processor paths', async () => {
    const cases = [
      {
        code: (packageName: string) => dedent`
          import { css } from '${packageName}';

          export const className = css\`
            color: red;
          \`;
        `,
        processorPath: processorFile,
        semantics: cssTemplateSemantics,
        tagName: 'css',
      },
      {
        code: (packageName: string) => dedent`
          import { styled } from '${packageName}';

          export const Box = styled.div\`
            color: red;
          \`;
        `,
        processorPath: styledProcessorFile,
        semantics: styledTargetSemantics,
        tagName: 'styled',
      },
    ];

    await Promise.all(
      cases.map(async (item) => {
        const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
        const directEntryFile = join(root, `direct-${item.tagName}.js`);
        const manifestEntryFile = join(root, `manifest-${item.tagName}.js`);
        const directPackageName = nextProcessorPackageName(
          `direct-${item.tagName}`
        );
        const manifestPackageName = nextProcessorPackageName(
          `manifest-${item.tagName}`
        );

        createFixtureProcessorPackage(root, {
          packageName: directPackageName,
          processorPath: item.processorPath,
          tagName: item.tagName,
        });
        createFixtureProcessorPackage(root, {
          packageName: manifestPackageName,
          processorPath: item.processorPath,
          semantics: item.semantics,
          tagName: item.tagName,
        });
        writeFileSync(directEntryFile, item.code(directPackageName));
        writeFileSync(manifestEntryFile, item.code(manifestPackageName));

        try {
          const directResult = await runTransformWithPackageLookup(
            root,
            directEntryFile,
            new TransformCacheCollection(),
            undefined,
            {
              classNameSlug: '[title]-[index]',
            }
          );
          const manifestResult = await runTransformWithPackageLookup(
            root,
            manifestEntryFile,
            new TransformCacheCollection(),
            undefined,
            {
              classNameSlug: '[title]-[index]',
            }
          );
          const normalizeCode = (code: string, packageName: string) =>
            code.replaceAll(packageName, '<processor-package>');

          expect(manifestResult.cssText).toBe(directResult.cssText);
          expect(
            normalizeCode(manifestResult.code, manifestPackageName)
          ).toEqual(normalizeCode(directResult.code, directPackageName));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      })
    );
  });

  it('falls back to the JS processor implementation for unsupported manifest semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const directEntryFile = join(root, 'direct.js');
    const manifestEntryFile = join(root, 'manifest.js');
    const directPackageName = nextProcessorPackageName(
      'unsupported-direct-css'
    );
    const manifestPackageName = nextProcessorPackageName(
      'unsupported-manifest-css'
    );
    const directPerf = createPerfEventRecorder();
    const manifestPerf = createPerfEventRecorder();

    writeProcessorPackage(root, {
      implementationSource: manifestOnlyCssProcessorSource,
      packageName: directPackageName,
      tagName: 'css',
    });
    writeProcessorPackage(root, {
      implementationSource: manifestOnlyCssProcessorSource,
      packageName: manifestPackageName,
      semantics: {
        kind: 'future-css-template',
      },
      tagName: 'css',
    });
    writeFileSync(
      directEntryFile,
      dedent`
        import { css } from '${directPackageName}';

        const marker = css\`\`;

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
        \`;
      `
    );
    writeFileSync(
      manifestEntryFile,
      readFileSync(directEntryFile, 'utf8').replaceAll(
        directPackageName,
        manifestPackageName
      )
    );

    try {
      const directResult = await runTransformWithPackageLookup(
        root,
        directEntryFile,
        new TransformCacheCollection(),
        directPerf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
        }
      );
      const manifestResult = await runTransformWithPackageLookup(
        root,
        manifestEntryFile,
        new TransformCacheCollection(),
        manifestPerf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
        }
      );

      expect(manifestResult.cssText).toBe(directResult.cssText);
      expect(
        manifestResult.code.replaceAll(
          manifestPackageName,
          '<processor-package>'
        )
      ).toEqual(
        directResult.code.replaceAll(directPackageName, '<processor-package>')
      );
      expect(directPerf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(
        0
      );
      expect(
        manifestPerf.counts.get('transform:evalFile') ?? 0
      ).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses dx-styles call manifest semantics for static call inputs before eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const stylePackageName = nextProcessorPackageName('manifest-style-call');
    const createVarPackageName = nextProcessorPackageName(
      'manifest-create-var-call'
    );
    const tokenPackageName = nextProcessorPackageName(
      'manifest-token-contract-call'
    );
    const classNamePackageName = nextProcessorPackageName(
      'manifest-class-name-call'
    );
    const cssPackageName = nextProcessorPackageName('manifest-css-template');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeProcessorPackage(root, {
      implementationSource: manifestOnlyStyleCallProcessorSource,
      packageName: stylePackageName,
      semantics: dxStyleObjectCallSemantics,
      tagName: 'style',
    });
    writeProcessorPackage(root, {
      implementationSource: manifestOnlyCreateVarProcessorSource,
      packageName: createVarPackageName,
      semantics: dxCssVarCallSemantics,
      tagName: 'createVar',
    });
    writeProcessorPackage(root, {
      implementationSource: manifestOnlyTokenContractProcessorSource,
      packageName: tokenPackageName,
      semantics: dxTokenContractCallSemantics,
      tagName: 'createTokenContract',
    });
    writeProcessorPackage(root, {
      implementationSource: manifestOnlyClassNameCallProcessorSource,
      packageName: classNamePackageName,
      semantics: dxClassNameCallSemantics,
      tagName: 'createTheme',
    });
    createFixtureProcessorPackage(root, {
      packageName: cssPackageName,
      processorPath: processorFile,
      semantics: cssTemplateSemantics,
      tagName: 'css',
    });
    writeFileSync(
      entryFile,
      dedent`
        import { style } from '${stylePackageName}';
        import { createVar } from '${createVarPackageName}';
        import { createTokenContract } from '${tokenPackageName}';
        import { createTheme } from '${classNamePackageName}';
        import { css } from '${cssPackageName}';

        const handle = { __dxStyles: { kind: 'styleHandle', className: 'dx-handle' } };
        const onlyHandle = style(handle);
        const localStyle = style({ color: 'red' });
        const localVar = createVar();
        const tokens = createTokenContract(
          { color: null, nested: { gap: 'space' } },
          { prefix: 'dx' }
        );
        const theme = createTheme(tokens, { color: 'blue', nested: { gap: '4px' } });

        export const className = css\`
          .${'${onlyHandle}'} {
            color: ${'${tokens.color}'};
          }
          .${'${localStyle}'} {
            background: ${'${localVar}'};
          }
          .${'${theme}'} {
            margin: ${'${tokens.nested.gap}'};
          }
        \`;
      `
    );

    try {
      const result = await runTransformWithPackageLookup(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
        }
      );

      expect(result.cssText).toContain('.dx-handle');
      expect(result.cssText).toContain('var(--dx-color)');
      expect(result.cssText).toContain('var(--dx-space)');
      expect(result.cssText).toContain('var(--localVar-2)');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses dx-styles token contract manifest semantics with cross-file static shape before eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const tokensFile = join(root, 'tokens.js');
    const tokenPackageName = nextProcessorPackageName(
      'manifest-token-contract-call'
    );
    const cssPackageName = nextProcessorPackageName('manifest-css-template');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeProcessorPackage(root, {
      implementationSource: manifestOnlyTokenContractProcessorSource,
      packageName: tokenPackageName,
      semantics: dxTokenContractCallSemantics,
      tagName: 'createTokenContract',
    });
    createFixtureProcessorPackage(root, {
      packageName: cssPackageName,
      processorPath: processorFile,
      semantics: cssTemplateSemantics,
      tagName: 'css',
    });
    writeFileSync(
      tokensFile,
      dedent`
        export const tokenShape = {
          color: null,
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { createTokenContract } from '${tokenPackageName}';
        import { css } from '${cssPackageName}';
        import { tokenShape } from './tokens.js';

        const tokens = createTokenContract(tokenShape, { prefix: 'dx' });

        export const className = css\`
          color: ${'${tokens.color}'};
        \`;
      `
    );

    try {
      const result = await runTransformWithPackageLookup(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
          eval: {
            strategy: 'static',
          },
        }
      );

      expect(result.cssText).toContain('var(--dx-color)');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a dx-like token contract through another file before consumer processor eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const contractFile = join(root, 'contract.js');
    const tokenOptionsFile = join(root, 'token-options.js');
    const tokenShapeFile = join(root, 'token-shape.js');
    const tokenPackageName = nextProcessorPackageName(
      'dx-like-token-contract-call'
    );
    const cssPackageName = nextProcessorPackageName('manifest-css-template');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeProcessorPackage(root, {
      implementationSource: dxLikeTokenContractProcessorSource,
      packageName: tokenPackageName,
      semantics: dxTokenContractCallSemantics,
      tagName: 'createTokenContract',
    });
    createFixtureProcessorPackage(root, {
      packageName: cssPackageName,
      processorPath: processorFile,
      semantics: cssTemplateSemantics,
      tagName: 'css',
    });
    writeFileSync(
      tokenShapeFile,
      dedent`
        export const colorTokens = {
          accent: null,
        };

        export const spacingTokens = {
          md: 'space-md',
        };

        export const tokenShape = {
          color: colorTokens,
          spacing: spacingTokens,
        };
      `
    );
    writeFileSync(
      tokenOptionsFile,
      dedent`
        export const tokenPrefix = 'dx';

        export const tokenOptions = {
          prefix: tokenPrefix,
        };
      `
    );
    writeFileSync(
      contractFile,
      dedent`
        import { createTokenContract } from '${tokenPackageName}';
        import { tokenOptions } from './token-options.js';
        import { tokenShape } from './token-shape.js';

        export const tokens = createTokenContract(tokenShape, tokenOptions);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from '${cssPackageName}';
        import { tokens } from './contract.js';

        export const className = css\`
          color: ${'${tokens.color.accent}'};
          margin: ${'${tokens.spacing.md}'};
        \`;
      `
    );

    try {
      const result = await runTransformWithPackageLookup(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
          eval: {
            strategy: 'static',
          },
        }
      );

      expect(result.cssText).toContain('var(--dx-color-accent)');
      expect(result.cssText).toContain('var(--dx-space-md)');
      expect(result.code).not.toContain('__dxLikePreevalCreateTokenContract');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not coerce cross-file object processor inputs to const expression values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const tokensFile = join(root, 'tokens.js');
    const packageName = nextProcessorPackageName('evaltime-static-object');
    const cache = new TransformCacheCollection();

    writeProcessorPackage(root, {
      implementationSource: evaltimeStaticObjectProcessorSource,
      packageName,
      tagName: 'createTokenContract',
    });
    writeFileSync(
      tokensFile,
      dedent`
        export const rawTokens = {
          palette: {
            primary: 'tomato',
          },
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { createTokenContract } from '${packageName}';
        import { rawTokens } from './tokens.js';

        export const tokens = createTokenContract(rawTokens);
      `
    );

    try {
      const result = await runTransformWithPackageLookup(
        root,
        entryFile,
        cache,
        undefined,
        {
          classNameSlug: '[title]-[index]',
        }
      );

      expect(result.code).toContain('"evaltime-static-object"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to JS eval for dx-styles call manifest semantics with non-static args', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const directEntryFile = join(root, 'direct.js');
    const manifestEntryFile = join(root, 'manifest.js');
    const directStylePackageName =
      nextProcessorPackageName('direct-style-call');
    const manifestStylePackageName = nextProcessorPackageName(
      'manifest-style-call'
    );
    const cssPackageName = nextProcessorPackageName('manifest-css-template');
    const directPerf = createPerfEventRecorder();
    const manifestPerf = createPerfEventRecorder();

    writeProcessorPackage(root, {
      implementationSource: manifestOnlyStyleCallProcessorSource,
      packageName: directStylePackageName,
      tagName: 'style',
    });
    writeProcessorPackage(root, {
      implementationSource: manifestOnlyStyleCallProcessorSource,
      packageName: manifestStylePackageName,
      semantics: dxStyleObjectCallSemantics,
      tagName: 'style',
    });
    createFixtureProcessorPackage(root, {
      packageName: cssPackageName,
      processorPath: processorFile,
      semantics: cssTemplateSemantics,
      tagName: 'css',
    });

    const source = (stylePackageName: string) => dedent`
      import { style } from '${stylePackageName}';
      import { css } from '${cssPackageName}';

      const dynamicStyle = { color: Date.now() > 0 ? 'red' : 'blue' };
      const localStyle = style(dynamicStyle);

      export const className = css\`
        .${'${localStyle}'} {
          color: blue;
        }
      \`;
    `;
    writeFileSync(directEntryFile, source(directStylePackageName));
    writeFileSync(manifestEntryFile, source(manifestStylePackageName));

    try {
      const directResult = await runTransformWithPackageLookup(
        root,
        directEntryFile,
        new TransformCacheCollection(),
        directPerf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
        }
      );
      const manifestResult = await runTransformWithPackageLookup(
        root,
        manifestEntryFile,
        new TransformCacheCollection(),
        manifestPerf.eventEmitter,
        {
          classNameSlug: '[title]-[index]',
        }
      );
      const normalizeCode = (code: string, stylePackageName: string) =>
        code.replaceAll(stylePackageName, '<style-package>');

      expect(manifestResult.cssText).toBe(directResult.cssText);
      expect(
        normalizeCode(manifestResult.code, manifestStylePackageName)
      ).toEqual(normalizeCode(directResult.code, directStylePackageName));
      expect(directPerf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(
        0
      );
      expect(
        manifestPerf.counts.get('transform:evalFile') ?? 0
      ).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file selector-only processor object members without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { styled } from 'test-styled-processor';

        export const modifiers = {
          empty: css\`\`,
        };

        const UnstyledNotice = () => null;

        const Notice = styled(UnstyledNotice)\`
          &.${'${modifiers.empty}'} {
            color: red;
          }
        \`;

        export default Object.assign(Notice, modifiers);
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines namespace selector-only processor class names without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const runtimeOnly = (() => {
          throw new Error('namespace class should not be imported during eval');
        })();

        export const marker = css\`\`;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import * as classes from './classes.js';

        export const className = css\`
          .${'${classes.marker}'} {
            color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(classesFile);
      expect(result.code).not.toContain('./classes.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported processor class names with CSS rules while preserving a side-effect import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        export const marker = css\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).not.toContain('color:blue');
      expect(result.dependencies).toContain(classesFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves imported processor CSS side effects with execute evaluation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const helperFile = join(root, 'helper.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const color = String('blue');
        export const marker = css\`
          color: ${'${color}'};
        \`;
      `
    );
    writeFileSync(
      helperFile,
      dedent`
        export const select = (value) => value;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';
        import { select } from './helper.js';

        export const className = css\`
          .${'${select(marker)}'} {
            color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          eval: { strategy: 'execute' },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).not.toContain('color:blue');
      expect(result.code).toContain("import './classes.js';");
      expect(result.code).not.toContain('import { marker }');
      expect(result.code).not.toContain('./helper.js');
      expect(result.dependencies).toContain(classesFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
      expect(
        perf.events.filter((event) => event.type === 'staticResolve')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            exported: 'marker',
            filename: classesFile,
            phase: 'processor-metadata',
            reason: 'non-empty-css-artifact-side-effect',
            status: 'resolved',
          }),
        ])
      );
    } finally {
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders preserved static side-effect imports by template dependency order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const layoutFile = join(root, 'layout.js');
    const checkboxFile = join(root, 'checkbox.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      layoutFile,
      dedent`
        import { css } from 'test-css-processor';

        export const modal = css\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      checkboxFile,
      dedent`
        import { css } from 'test-css-processor';

        export const checkboxClass = css\`
          color: green;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { checkboxClass } from './checkbox.js';
        import { modal } from './layout.js';

        export const className = css\`
          .${'${modal}'} {
            color: red;
          }

          .${'${checkboxClass}'} {
            color: black;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('color:black');
      expect(result.cssText).not.toContain('color:blue');
      expect(result.cssText).not.toContain('color:green');
      const layoutImportIndex = result.code.indexOf("import './layout.js';");
      const checkboxImportIndex = result.code.indexOf(
        "import './checkbox.js';"
      );

      expect(layoutImportIndex).toBeGreaterThanOrEqual(0);
      expect(checkboxImportIndex).toBeGreaterThanOrEqual(0);
      expect(layoutImportIndex).toBeLessThan(checkboxImportIndex);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders removed static side-effect imports after kept side-effect anchors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const layoutFile = join(root, 'layout.js');
    const checkboxFile = join(root, 'checkbox.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      layoutFile,
      dedent`
        import { css } from 'test-css-processor';

        export const modal = css\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      checkboxFile,
      dedent`
        import { css } from 'test-css-processor';

        export const checkboxClass = css\`
          color: green;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { checkboxClass } from './checkbox.js';
        import { modal } from './layout.js';

        export const kept = modal;
        export const className = css\`
          .${'${modal}'} {
            color: red;
          }

          .${'${checkboxClass}'} {
            color: black;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      const layoutImportIndex = result.code.indexOf(
        "import { modal } from './layout.js';"
      );
      const checkboxImportIndex = result.code.indexOf(
        "import './checkbox.js';"
      );

      expect(layoutImportIndex).toBeGreaterThanOrEqual(0);
      expect(checkboxImportIndex).toBeGreaterThanOrEqual(0);
      expect(layoutImportIndex).toBeLessThan(checkboxImportIndex);
      expect(result.code).toContain('export const kept = modal;');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders removed static side-effect imports after kept static metadata anchors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const layoutFile = join(root, 'layout.js');
    const checkboxFile = join(root, 'checkbox.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      layoutFile,
      dedent`
        import { styled } from 'test-runtime-styled-processor';

        export const modal = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      checkboxFile,
      dedent`
        import { css } from 'test-css-processor';

        export const checkboxClass = css\`
          color: green;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { checkboxClass } from './checkbox.js';
        import { modal } from './layout.js';

        export const kept = modal;
        export const className = css\`
          .${'${modal}'} {
            color: red;
          }

          .${'${checkboxClass}'} {
            color: black;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      const layoutImportIndex = result.code.indexOf(
        "import { modal } from './layout.js';"
      );
      const checkboxImportIndex = result.code.indexOf(
        "import './checkbox.js';"
      );

      expect(layoutImportIndex).toBeGreaterThanOrEqual(0);
      expect(checkboxImportIndex).toBeGreaterThanOrEqual(0);
      expect(layoutImportIndex).toBeLessThan(checkboxImportIndex);
      expect(result.code).toContain('export const kept = modal;');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported processor class name objects with static imports without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const tokensFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      tokensFile,
      `export const breakpoint = '(max-width: 600px)';`
    );
    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';
        import { breakpoint } from './tokens.js';

        export const HeadingStyles = {
          Heading1: css\`
            font-size: 28px;

            @media ${'${breakpoint}'} {
              font-size: 22px;
            }
          \`,
          Heading2: css\`
            font-size: 22px;

            @media ${'${breakpoint}'} {
              font-size: 18px;
            }
          \`,
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { HeadingStyles } from './classes.js';

        export const title = css\`
          .${'${HeadingStyles.Heading2}'} {
            margin: 0;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('margin:0');
      expect(result.cssText).not.toContain('font-size:22px');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(
        result.dependencies.some(
          (dependency) =>
            dependency === classesFile || dependency === './classes.js'
        )
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines mixed styled metadata and class-name object exports without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const stylesFile = join(root, 'styles.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      stylesFile,
      dedent`
        import { css } from 'test-css-processor';
        import { styled } from 'test-styled-processor';

        const runtimeOnly = (() => {
          throw new Error('mixed style object should not run during eval');
        })();

        const Container = styled.div\`
          display: flex;
        \`;

        const CloseButton = styled.button\`
          color: red;
        \`;

        const Clickable = css\`
          cursor: pointer;
        \`;

        export const Styles = {
          Container,
          CloseButton,
          Clickable,
        };

        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Styles } from './styles.js';

        export const Dialog = styled.div\`
          ${'${Styles.Container}'} {
            margin: 0;
          }

          .${'${Styles.Clickable}'} {
            color: blue;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('margin:0');
      expect(result.cssText).toContain('color:blue');
      expect(
        result.dependencies.some(
          (dependency) =>
            dependency === stylesFile || dependency === './styles.js'
        )
      ).toBe(true);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers processor static contract values over legacy replacement expressions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-static-contract-css-processor';
        import { styled } from 'test-styled-processor';

        const Base = css\`
          color: red;
        \`;

        export const Box = styled.div\`
          .${'${Base}'} {
            color: blue;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('.contract-');
      expect(result.cssText).not.toContain('.legacy-');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines mixed styled metadata object exports with local runtime bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const buttonFile = join(root, 'button.js');
    const stylesFile = join(root, 'styles.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      buttonFile,
      dedent`
        const Button = (props) => {
          const kind = props.kind;
          return kind ? null : null;
        };

        export { Button };
      `
    );
    writeFileSync(
      stylesFile,
      dedent`
        import { css } from 'test-css-processor';
        import { styled } from 'test-styled-processor';
        import { Button } from './button.js';

        const CloseButton = styled(Button)\`
          color: red;
        \`;

        const Collapse = styled.button\`
          transform: rotate(${"${props => (props.collapsed ? '-90deg' : '0deg')}"});
        \`;

        const Clickable = css\`
          cursor: pointer;
        \`;

        export const Styles = {
          CloseButton,
          Collapse,
          Clickable,
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Styles } from './styles.js';

        export const Dialog = styled.div\`
          ${'${Styles.CloseButton}'} {
            margin: 0;
          }

          .${'${Styles.Clickable}'} {
            color: blue;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('margin:0');
      expect(result.cssText).toContain('color:blue');
      expect(
        result.dependencies.some(
          (dependency) =>
            dependency === stylesFile || dependency === './styles.js'
        )
      ).toBe(true);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps preserved class side-effect imports out of eval runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const dynamicFile = join(root, 'dynamic.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const runtimeOnly = (() => {
          throw new Error('side-effect class import should not be imported during eval');
        })();

        export const marker = css\`
          color: blue;
        \`;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      dynamicFile,
      dedent`
        export const spacing = \`\${Date.now()}px\`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';
        import { spacing } from './dynamic.js';

        export const className = css\`
          .${'${marker}'} {
            margin: ${'${spacing}'};
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('margin:');
      expect(result.cssText).not.toContain('color:blue');
      expect(result.code).toContain('./classes.js');
      expect(result.dependencies).toContain(classesFile);
      expect(result.dependencies).toContain('./dynamic.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported styled primitive metadata without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Base = styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines local package styled metadata outside the app root without eval', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const root = join(temp, 'app');
    const sharedRoot = join(temp, 'shared');
    const entryFile = join(root, 'entry.js');
    const baseFile = join(sharedRoot, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    mkdirSync(root, { recursive: true });
    mkdirSync(sharedRoot, { recursive: true });
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Base = styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from '../shared/base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for a local runtime component without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Runtime = () => null;

        export const Base = styled(Runtime)\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges retained eval stubs with statically proven opaque styled targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'StyledLink.js');
    const linkFile = join(root, 'Link.js');
    const themeFile = join(root, 'runtime-theme.js');
    const cache = new TransformCacheCollection();
    let opaqueNames: string[] = [];
    const evaluateSpy = jest
      .spyOn(EvalBroker.prototype, 'evaluate')
      .mockImplementation(async (entrypoint) => {
        const preevalResult = entrypoint.getPreevalResult();
        const staticValues = preevalResult?.staticValueCache;
        opaqueNames = preevalResult?.staticNullWYWMetaExtendsHelpers ?? [];
        expect(opaqueNames).toHaveLength(1);
        expect(staticValues).toBeDefined();
        if (!preevalResult || !staticValues) {
          throw new Error('expected a resolved static preeval result');
        }

        const toEvaluatedValue = (value: unknown): unknown => {
          if (
            typeof value !== 'object' ||
            value === null ||
            !('__wyw_meta' in value)
          ) {
            return value;
          }

          const meta = value.__wyw_meta as {
            className: string;
            extends: unknown;
          };
          return {
            displayName:
              'displayName' in value
                ? value.displayName
                : 'RetainedStyledValue',
            __wyw_meta: {
              className: meta.className,
              extends:
                meta.extends === null
                  ? () => {}
                  : toEvaluatedValue(meta.extends),
            },
          };
        };
        const values = new Map<string, unknown>(
          (preevalResult.dependencyNames ?? []).map((name) => [name, 'red'])
        );
        staticValues.forEach((value, name) => {
          values.set(
            name,
            opaqueNames.includes(name) ? () => {} : toEvaluatedValue(value)
          );
        });

        return { dependencies: [], values };
      });

    writeFileSync(linkFile, 'export const Link = () => null;\n');
    writeFileSync(
      themeFile,
      "export const color = Date.now() > 0 ? 'red' : 'blue';\n"
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Link } from './Link.js';
        import { color } from './runtime-theme.js';

        const StyledLink = styled(Link)\`
          display: flex;
        \`;

        export const StyledTextLink = styled(StyledLink)\`
          color: \${color};
        \`;
      `
    );

    try {
      const transformed = await runTransform(root, entryFile, cache);

      expect(evaluateSpy).toHaveBeenCalledTimes(1);
      expect(opaqueNames).toHaveLength(1);
      expect(transformed.cssText).toContain('display:flex');
      expect(transformed.cssText).toContain('color:red');
      expect(transformed.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*color:red;[^}]*\}/s
      );
    } finally {
      evaluateSpy.mockRestore();
      disposeEvalBroker(cache);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps local runtime component references in runtime styled output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-runtime-styled-processor';

        const Layout = () => 'runtime';

        export default styled(Layout)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('color:red');
      expect(result.code).toContain("const Layout = () => 'runtime';");
      expect(result.code).toContain('const _exp = () => (Layout);');
      expect(result.code).toContain('styled(_exp())');
      expect(result.code).not.toContain('styled(() => {})');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps same-file styled component selector interpolations as class selectors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Item = styled.div\`
          color: red;
        \`;

        export const Row = styled.div\`
          & > ${'${Item}'}:last-of-type {
            color: blue;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {},
        createResolver(styledProcessorFile)
      );

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toMatch(/>\.[_a-zA-Z][_a-zA-Z0-9-]*:last-of-type/);
      expect(result.cssText).not.toMatch(
        />[_a-zA-Z][_a-zA-Z0-9-]*:last-of-type/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for a local React runtime wrapper without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import React from 'react';
        import { styled } from 'test-styled-processor';

        const Runtime = React.forwardRef(() => null);

        export const Base = styled(Runtime)\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an imported React runtime wrapper export without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        import React from 'react';

        const runtimeOnly = (() => {
          throw new Error('runtime wrapper should not be imported during eval');
        })();

        export const Runtime = React.memo(() => null);
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Runtime } from './runtime.js';

        export const Base = styled(Runtime)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(runtimeFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an imported observer runtime wrapper export without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        import { observer } from 'mobx-react-lite';

        const runtimeOnly = (() => {
          throw new Error('observer wrapper should not be imported during eval');
        })();

        export const Runtime = observer(() => null);
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Runtime } from './runtime.js';

        export const Base = styled(Runtime)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(runtimeFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an imported runtime factory export without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        import React from 'react';

        const runtimeOnly = (() => {
          throw new Error('runtime factory should not be imported during eval');
        })();

        const createRuntime = (kind) => {
          return React.forwardRef((props, ref) => null);
        };

        export const Runtime = createRuntime('warning');
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Runtime } from './runtime.js';

        export const Base = styled(Runtime)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain(runtimeFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles styled runtime wrappers that attach symbol-keyed component references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'BaseImage.js');
    const hocFile = join(root, 'hocWithSymbol.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      baseFile,
      dedent`
        export const BaseImage = (props) => null;
      `
    );
    writeFileSync(
      hocFile,
      dedent`
        export const hocSymbol = Symbol('hocSymbol');

        export function wrapWithSymbol(Component) {
          const descriptor = { render: Component };
          descriptor[hocSymbol] = Component;
          return descriptor;
        }
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { BaseImage } from './BaseImage.js';
        import { wrapWithSymbol } from './hocWithSymbol.js';

        export const A = styled(wrapWithSymbol(BaseImage))\`
          border-radius: 8px;
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('border-radius:8px');
      expect(result.dependencies).toEqual(
        expect.arrayContaining(['./BaseImage.js', './hocWithSymbol.js'])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['hybrid', 'execute'] as const)(
    'wraps a styled-components-shaped imported target in %s mode',
    async (strategy) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const baseFile = join(root, 'ForeignDescriptor.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(
        baseFile,
        dedent`
          class ComponentStyle {
            constructor() {
              this.rules = ['color: red;'];
            }
          }

          const RuntimeTarget = () => null;

          export const Base = {
            $$typeof: Symbol.for('react.forward_ref'),
            render: () => null,
            attrs: [],
            componentStyle: new ComponentStyle(),
            shouldForwardProp: (prop) => prop !== 'hidden',
            foldedComponentIds: 'sc-foreign-base ',
            styledComponentId: 'sc-foreign-base',
            target: RuntimeTarget,
            warnTooManyClasses: () => {},
          };
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { styled } from 'test-styled-processor';
          import { Base } from './ForeignDescriptor.js';

          export const Derived = styled(Base)\`
            font-weight: bold;
          \`;
        `
      );

      try {
        const result = await runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          { eval: { strategy } }
        );

        expect(result.cssText).toContain('font-weight:bold');
        expect(result.dependencies).toContain('./ForeignDescriptor.js');
        if (strategy === 'hybrid') {
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        disposeEvalBroker(cache);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['hybrid', 'execute'] as const)(
    'preserves styled-components-shaped selector metadata beside opaque runtime fields in %s mode',
    async (strategy) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const baseFile = join(root, 'ForeignDescriptor.js');
      const cache = new TransformCacheCollection();
      const perf = createPerfEventRecorder();

      writeFileSync(
        baseFile,
        dedent`
          class ComponentStyle {
            constructor() {
              this.rules = ['color: red;'];
            }
          }

          const RuntimeTarget = () => null;

          export const Base = {
            $$typeof: Symbol.for('react.forward_ref'),
            render: () => null,
            attrs: [],
            componentStyle: new ComponentStyle(),
            shouldForwardProp: (prop) => prop !== 'hidden',
            foldedComponentIds: 'sc-foreign-base ',
            styledComponentId: 'sc-foreign-base',
            target: RuntimeTarget,
            warnTooManyClasses: () => {},
            __wyw_meta: {
              className: 'foreign-base',
              extends: null,
            },
          };
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { styled } from 'test-styled-processor';
          import { Base } from './ForeignDescriptor.js';

          export const Derived = styled.div\`
            ${'${Base}'} {
              font-weight: bold;
            }
          \`;
        `
      );

      try {
        const result = await runTransform(
          root,
          entryFile,
          cache,
          perf.eventEmitter,
          { eval: { strategy } }
        );

        expect(result.cssText).toContain('font-weight:bold');
        expect(result.cssText).toContain('.foreign-base');
        expect(result.dependencies).toContain('./ForeignDescriptor.js');
        if (strategy === 'hybrid') {
          expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
        }
      } finally {
        disposeEvalBroker(cache);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['hybrid', 'execute'] as const)(
    'keeps imported foreign descriptor targets in runtime styled output in %s mode',
    async (strategy) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
      const entryFile = join(root, 'entry.js');
      const baseFile = join(root, 'ForeignDescriptor.js');
      const cache = new TransformCacheCollection();

      writeFileSync(
        baseFile,
        dedent`
          class ComponentStyle {}

          const RuntimeTarget = () => 'runtime target';

          export const Base = {
            $$typeof: Symbol.for('react.forward_ref'),
            render: RuntimeTarget,
            attrs: [],
            componentStyle: new ComponentStyle(),
            shouldForwardProp: (prop) => prop !== 'hidden',
            foldedComponentIds: 'sc-foreign-base ',
            styledComponentId: 'sc-foreign-base',
            target: RuntimeTarget,
            warnTooManyClasses: () => {},
            __wyw_meta: {
              className: 'foreign-base',
              extends: null,
            },
          };
        `
      );
      writeFileSync(
        entryFile,
        dedent`
          import { styled } from 'test-runtime-styled-processor';
          import { Base } from './ForeignDescriptor.js';

          export const Wrapped = styled(Base)\`
            color: red;
          \`;
        `
      );

      try {
        const result = await runTransform(root, entryFile, cache, undefined, {
          eval: { strategy },
        });

        expect(result.cssText).toContain('color:red');
        expect(result.code).toMatch(
          /import\s*\{\s*Base\s*\}\s*from\s*['"]\.\/ForeignDescriptor\.js['"]/
        );
        expect(result.code).toContain('const _exp = () => (Base);');
        expect(result.code).toContain('styled(_exp())');
        expect(result.code).not.toContain('styled(() => {})');
        expect(result.code).not.toContain('styled(null)');
        expect(result.dependencies).toContain('./ForeignDescriptor.js');
      } finally {
        disposeEvalBroker(cache);
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('preserves readable metadata beside unreadable runtime fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'ForeignDescriptor.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      baseFile,
      dedent`
        class RuntimeState {}

        const RuntimeBase = {
          kind: 'runtime-base',
          runtimeState: new RuntimeState(),
        };

        export const Base = {
          __wyw_meta: {
            className: 'foreign-base',
            extends: RuntimeBase,
          },
          runtimeState: new RuntimeState(),
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './ForeignDescriptor.js';

        export const Derived = styled(Base)\`
          font-weight: bold;
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache, undefined, {
        eval: { strategy: 'execute' },
      });

      expect(result.cssText).toContain('font-weight:bold');
      expect(result.cssText).toContain('.foreign-base');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still rejects unreadable runtime fields used as CSS data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'ForeignDescriptor.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      baseFile,
      dedent`
        class RuntimeState {}

        export const Base = {
          kind: 'foreign-descriptor',
          render: () => null,
          runtimeState: new RuntimeState(),
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { Base } from './ForeignDescriptor.js';

        export const className = css\`
          ${'${Base}'}
        \`;
      `
    );

    try {
      await expect(runTransform(root, entryFile, cache)).rejects.toThrow(
        '__wywPreval._exp.runtimeState'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines nested styled metadata object values with runtime bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const stylesFile = join(root, 'styles.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        const runtimeOnly = (() => {
          throw new Error('nested runtime base should not be imported during eval');
        })();

        export const Button = () => null;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      stylesFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Button } from './runtime.js';

        export const Styles = {
          Primary: styled(Button)\`
            color: red;
          \`,
          Secondary: styled(Button)\`
            color: blue;
          \`,
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { Styles } from './styles.js';

        export const className = css\`
          .${'${Styles.Primary.__wyw_meta.className}'} {
            border-color: red;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('border-color:red');
      expect(result.dependencies).toEqual(
        expect.arrayContaining([runtimeFile, stylesFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata with safe post-declaration Object.assign aliases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Runtime = () => null;
        const Alias = styled.div\`
          color: blue;
        \`;
        const Base = styled(Runtime)\`
          color: red;
        \`;

        Object.assign(Base, { Alias });

        export default Base;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Base from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines post-declaration Object.assign alias members without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Infix = styled.span\`
          color: blue;
        \`;
        const Base = styled.div\`
          color: red;
        \`;

        Object.assign(Base, { Infix });

        export default Base;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Base from './base.js';

        export const Extended = styled(Base.Infix)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps unsafe post-declaration styled metadata calls on the eval path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Runtime = () => null;
        const Base = styled(Runtime)\`
          color: red;
        \`;

        function touch(value) {
          return value;
        }

        touch(Base);

        export default Base;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Base from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.dependencies).toContain('./base.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an external runtime namespace primitive without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import * as Tabs from '@radix-ui/react-tabs';

        export const Base = styled(Tabs.Root)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps unresolved external runtime primitives outside the allowlist on the eval path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime-ui.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const defaultResolve = createResolver(processorFile);
    const asyncResolve = async (what: string, importer: string) => {
      if (what === 'runtime-ui') {
        return runtimeFile;
      }

      return defaultResolve(what, importer);
    };

    writeFileSync(
      runtimeFile,
      dedent`
        export const Root = (() => () => null)();
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import * as UI from 'runtime-ui';

        export const Base = styled(UI.Root)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {},
        asyncResolve
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for a direct SVG runtime import without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import SvgIcon from './icon.svg?react';

        export const Base = styled(SvgIcon)\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an SVG runtime import re-exported through a barrel without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const iconsFile = join(root, 'icons.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      iconsFile,
      dedent`
        import SvgIcon from './icon.svg?react';

        export { SvgIcon as Icon };
      `
    );
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Icon } from './icons.js';

        export const Base = styled(Icon)\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toEqual(
        expect.arrayContaining([baseFile, iconsFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes static SVG metadata helpers when the file still needs eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(runtimeFile, `export const makeRuntime = () => null;`);
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import SvgIcon from './icon.svg?react';
        import { makeRuntime } from './runtime.js';

        const RuntimeBase = makeRuntime();

        export const Icon = styled(SvgIcon)\`
          color: red;
        \`;

        export const Dynamic = styled(RuntimeBase)\`
          font-size: 12px;
        \`;
      `
    );

    const resolver = createResolver(processorFile);
    const failOnRuntimeSvgResolve = async (what: string, importer: string) => {
      if (what.includes('.svg?react')) {
        throw new Error(`SVG import reached eval: ${what}`);
      }

      return resolver(what, importer);
    };

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {},
        failOnRuntimeSvgResolve
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('font-size:12px');
      // Inliner now resolves both styled() candidates statically; the SVG
      // resolver guard (failOnRuntimeSvgResolve) still ensures eval never
      // reaches the .svg?react import.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata wrapped in local Object.assign without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Base = styled.div\`
          color: red;
        \`;
        const aliases = {
          Root: Base,
        };

        export default Object.assign(Base, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Base from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata wrapped in Object.assign through a barrel without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const tableFile = join(root, 'table.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      tableFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Table = styled.div\`
          color: red;
        \`;
        export const Cell = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        import { Table, Cell } from './table.js';

        const aliases = {
          Cell,
        };

        export default Object.assign(Table, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Table from './barrel.js';

        export const Extended = styled(Table)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toEqual(
        expect.arrayContaining([barrelFile, tableFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata from Object.assign alias members without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const tableFile = join(root, 'table.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      tableFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Table = styled.div\`
          color: red;
        \`;
        export const Row = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        import { Row, Table } from './table.js';

        const aliases = {
          Row,
        };

        export default Object.assign(Table, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Table from './barrel.js';

        export const Extended = styled(Table.Row)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toEqual(
        expect.arrayContaining([barrelFile, tableFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-module Object.assign alias members without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const panelFile = join(root, 'panel.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      panelFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const aliases = {
          Body: styled.div\`
            color: blue;
          \`,
        };

        const Panel = styled.div\`
          color: red;
        \`;

        export default Object.assign(Panel, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Panel from './panel.js';

        export const Extended = styled(Panel.Body)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(panelFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines exported Object.assign alias members with opaque local bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const panelFile = join(root, 'panel.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      panelFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const RuntimeHeading = () => null;

        export const Heading = styled(RuntimeHeading)\`
          color: blue;
        \`;

        const aliases = {
          Heading,
        };

        const Panel = styled.div\`
          color: red;
        \`;

        export default Object.assign(Panel, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Panel from './panel.js';

        export const Extended = styled(Panel.Heading)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(panelFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps non-metadata Object.assign values on the eval path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'theme.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const aliases = {
          background: 'blue',
        };

        export const theme = Object.assign({ color: 'red' }, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { theme } from './theme.js';

        export const className = css\`
          color: ${'${theme.color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./theme.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled primitive metadata from a mixed module without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const runtimeOnly = (() => {
          throw new Error('runtime code should not run while resolving metadata');
        })();

        export const Base = styled.div\`
          color: red;
        \`;

        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines static styled metadata helpers into local styled chains before eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const flexFile = join(root, 'flex.js');
    const dynamicFile = join(root, 'dynamic.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      flexFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const runtimeOnly = (() => {
          throw new Error('styled primitive module should not run during eval');
        })();

        export const Horizontal = styled.div\`
          display: flex;
        \`;

        export const Spring = styled.div\`
          flex: 1;
        \`;

        export { runtimeOnly };
      `
    );
    writeFileSync(dynamicFile, `export const spacing = Date.now();`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { styled } from 'test-styled-processor';
        import { spacing } from './dynamic.js';
        import { Horizontal, Spring } from './flex.js';

        export const Runtime = () => Spring;

        const Row = styled(Horizontal)\`
          color: red;
        \`;

        export const Root = styled(Row)\`
          font-size: 12px;
        \`;

        export const className = css\`
          margin: ${'${spacing}'}px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('font-size:12px');
      expect(result.dependencies).toContain(flexFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('evaluates same-file styled selector chains with eval.strategy execute', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Base = styled.div\`
          color: red;
        \`;

        export const Root = styled(Base)\`
          font-size: 12px;
        \`;

        export const Wrapper = styled.div\`
          & > ${'${Root}'} {
            color: blue;
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {
          eval: { strategy: 'execute' },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toContain('color:blue');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.cssText).toMatch(
        />\s*\.[A-Za-z0-9_-]+\s*\{[^}]*color:blue;[^}]*\}/s
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file styled base metadata without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Base = styled.div\`
          color: red;
        \`;

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file null component bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
        import { styled } from 'test-styled-processor';
        import Feature from './Feature';

        const Features = ({ className }) => _jsxs('ul', {
          className,
          children: [_jsx(Feature, { icon: 'cloud' })],
        });

        export const Root = styled(Features)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file React wrapper null component bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import React from 'react';
        import { jsx as _jsx } from 'react/jsx-runtime';
        import { styled } from 'test-styled-processor';

        const BareAlert = ({ children }, ref) => {
          return _jsx('span', { ref, children });
        };
        const UnstyledAlert = React.forwardRef(BareAlert);

        export const Alert = styled(UnstyledAlert)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file React wrapper bases with sanitized render functions without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import React from 'react';
        import { styled } from 'test-styled-processor';

        const InputFieldRender = () => {
          setTimeout(() => {}, 1);
          return null;
        };
        const BareInputField = React.forwardRef(InputFieldRender);

        export const LabelsInputField = styled(BareInputField)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file default null component bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const BareEditor = () => null;

        export default styled(BareEditor)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file typed styled base metadata with runtime props without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.tsx');
    const flexFile = join(root, 'flex.tsx');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      flexFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const runtimeOnly = (() => {
          throw new Error('typed styled base should not be imported during eval');
        })();

        export const Horizontal = styled.div<{ inline?: boolean }>\`
          display: ${'${props => (props.inline === true ? "inline-flex" : "flex")}'};
          align-items: ${'${props => props.inline ? "center" : "normal"}'};
        \`;

        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Horizontal } from './flex.tsx';

        export const ContextItemPill = styled(Horizontal)<{ withRemoveIcon: boolean }>\`
          padding: ${'${props => (props.withRemoveIcon ? "2px 4px" : "2px 8px")}'};
        \`;

        export const ClickableContextItemPill = styled(ContextItemPill)\`
          cursor: pointer;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('cursor:pointer');
      expect(
        result.dependencies.some(
          (dependency) => dependency === flexFile || dependency === './flex.tsx'
        )
      ).toBe(true);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file styled chain selectors with imported bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const flexFile = join(root, 'flex.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      flexFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const runtimeOnly = (() => {
          throw new Error('styled primitive module should not run during eval');
        })();

        export const Vertical = styled.div\`
          display: flex;
          flex-direction: column;
        \`;

        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Vertical } from './flex.js';

        const FieldRow = styled(Vertical)\`
          gap: 8px;
        \`;

        const FullWidthFieldRow = styled(FieldRow)\`
        \`;

        export const DevPanel = styled.div\`
          & > ${'${FieldRow}'}:not(${'${FullWidthFieldRow}'}) {
            max-width: calc(50% - 8px);
          }

          @media (max-width: 600px) {
            & > ${'${FieldRow}'} {
              max-width: 100%;
            }
          }
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('gap:8px');
      expect(result.cssText).toContain('max-width:calc(50% - 8px)');
      expect(result.cssText).toMatch(/>\.[_a-zA-Z][_a-zA-Z0-9-]*:not\(\./);
      expect(result.dependencies).toContain(flexFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses cached static styled metadata across entry transforms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const firstEntryFile = join(root, 'entry-a.js');
    const secondEntryFile = join(root, 'entry-b.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const asyncResolve = createResolver(processorFile);

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Base = styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      firstEntryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );
    writeFileSync(
      secondEntryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 14px;
        \`;
      `
    );

    try {
      const first = await runTransform(
        root,
        firstEntryFile,
        cache,
        perf.eventEmitter,
        {},
        asyncResolve
      );
      const staticMetadataCount =
        perf.counts.get('transform:preeval:staticMetadata') ?? 0;
      expect(staticMetadataCount).toBeGreaterThan(0);
      const second = await runTransform(
        root,
        secondEntryFile,
        cache,
        perf.eventEmitter,
        {},
        asyncResolve
      );

      expect(first.cssText).toContain('font-size:12px');
      expect(second.cssText).toContain('font-size:14px');
      expect(perf.counts.get('transform:preeval:staticMetadata') ?? 0).toBe(
        staticMetadataCount
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses static metadata preeval for multiple exports from one file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Base = styled.div\`
          color: red;
        \`;

        export const Accent = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Accent, Base } from './base.js';

        export const ExtendedBase = styled(Base)\`
          font-size: 12px;
        \`;

        export const ExtendedAccent = styled(Accent)\`
          line-height: 16px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toContain('line-height:16px');
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:preeval:staticMetadata') ?? 0).toBe(1);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines transitive styled metadata chains without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const middleFile = join(root, 'middle.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Base = styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      middleFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Middle = styled(Base)\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Middle } from './middle.js';

        export const Extended = styled(Middle)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toEqual(
        expect.arrayContaining([baseFile, middleFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates cached output when a transitive static dependency changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const resolver = createResolver(processorFile);

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(barrelFile, `export { color } from './tokens.js';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './barrel.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const first = await runTransform(
        root,
        entryFile,
        cache,
        undefined,
        {},
        resolver
      );
      writeFileSync(depFile, `export const color = 'blue';`);
      const second = await runTransform(
        root,
        entryFile,
        cache,
        undefined,
        {},
        resolver
      );

      expect(first.cssText).toContain('color:red');
      expect(second.cssText).toContain('color:blue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not produce link errors when a re-export barrel needs exports shaken from a prior eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const tokensFile = join(root, 'tokens.js');
    const barrelFile = join(root, 'barrel.js');
    const entryA = join(root, 'entry-a.js');
    const entryB = join(root, 'entry-b.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      tokensFile,
      dedent`
        export const fontFamily = 'Inter, sans-serif';
        export const textStyles = { fontSize: '14px', lineHeight: '1.5' };
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        export { fontFamily } from './tokens.js';
      `
    );
    writeFileSync(
      entryA,
      dedent`
        import { css } from 'test-css-processor';
        import { textStyles } from './tokens.js';

        export const className = css\`
          font-size: ${'${textStyles.fontSize}'};
        \`;
      `
    );
    writeFileSync(
      entryB,
      dedent`
        import { css } from 'test-css-processor';
        import { fontFamily } from './barrel.js';

        export const className = css\`
          font-family: ${'${fontFamily}'};
        \`;
      `
    );

    try {
      // entry-a caches tokens.js with only=['textStyles'] (fontFamily shaken out)
      const resultA = await runTransform(root, entryA, cache);
      expect(resultA.cssText).toContain('font-size:14px');

      // entry-b needs fontFamily from tokens.js via barrel.js re-export.
      // The broker/runner must not serve a shaken variant that omits fontFamily.
      const resultB = await runTransform(root, entryB, cache);
      expect(resultB.cssText).toContain('font-family:Inter,sans-serif');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives concurrent transforms that need different exports from the same module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const tokensFile = join(root, 'tokens.js');
    const barrelFile = join(root, 'barrel.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      tokensFile,
      dedent`
        export const fontFamily = 'Inter, sans-serif';
        export const fontWeight = { light: 300, regular: 400, bold: 700 };
        export const textStyles = { fontSize: '14px', lineHeight: '1.5' };
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        export { fontFamily, fontWeight } from './tokens.js';
      `
    );

    // Create N entry files: half import textStyles directly, half import
    // fontFamily via barrel.  Run all transforms concurrently (like webpack).
    const N = 10;
    const entries: string[] = [];
    for (let i = 0; i < N; i++) {
      const entryFile = join(root, `entry-${i}.js`);
      if (i % 2 === 0) {
        writeFileSync(
          entryFile,
          dedent`
            import { css } from 'test-css-processor';
            import { textStyles } from './tokens.js';

            export const className = css\`
              font-size: ${'${textStyles.fontSize}'};
            \`;
          `
        );
      } else {
        writeFileSync(
          entryFile,
          dedent`
            import { css } from 'test-css-processor';
            import { fontFamily } from './barrel.js';

            export const className = css\`
              font-family: ${'${fontFamily}'};
            \`;
          `
        );
      }
      entries.push(entryFile);
    }

    try {
      // Run all transforms concurrently, sharing the same cache.
      const results = await Promise.all(
        entries.map((entry) => runTransform(root, entry, cache))
      );

      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) {
          expect(results[i].cssText).toContain('font-size:14px');
        } else {
          expect(results[i].cssText).toContain('font-family:Inter,sans-serif');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not produce link errors when the same module is imported directly and via barrel with different exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const tokensFile = join(root, 'tokens.js');
    const barrelFile = join(root, 'barrel.js');
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      tokensFile,
      dedent`
        export const fontFamily = 'Inter, sans-serif';
        export const fontWeight = { light: 300, regular: 400, bold: 700 };
        export const textStyles = { fontSize: '14px', lineHeight: '1.5' };
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        export { fontFamily, fontWeight } from './tokens.js';
      `
    );
    // Single entry that imports textStyles directly from tokens
    // AND fontFamily via the barrel — within one eval, the runner loads
    // tokens.js once for the direct import (only=['textStyles']) and once
    // during barrel.js linking (needs fontFamily+fontWeight).
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { textStyles } from './tokens.js';
        import { fontFamily, fontWeight } from './barrel.js';

        export const className = css\`
          font-size: ${'${textStyles.fontSize}'};
          font-family: ${'${fontFamily}'};
          font-weight: ${'${fontWeight.regular}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);
      expect(result.cssText).toContain('font-size:14px');
      expect(result.cssText).toContain('font-family:Inter,sans-serif');
      expect(result.cssText).toContain('font-weight:400');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extracts runtime processors from components removed from evaltime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-component-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { jsx as _jsx } from 'react/jsx-runtime';

        const color = 'red';
        export function Component() {
          const className = css\`
            color: ${'${color}'};
          \`;

          return _jsx('div', { className });
        }
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('color:red');
      expect(result.code).toContain('function Component()');
      expect(result.code).not.toContain('test-css-processor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
