/* eslint-env jest */
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { BaseProcessor } from '@wyw-in-js/processor-utils';
import * as shared from '@wyw-in-js/shared';

import { getProcessorForImport } from '../processors/processorLookup';

const processorFixturePath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const writeProcessorPackage = (
  packageDir: string,
  packageName: string,
  processorSource: string
): void => {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        main: './index.js',
        'wyw-in-js': {
          tags: {
            css: './processor.js',
          },
        },
      },
      null,
      2
    )
  );
  writeFileSync(path.join(packageDir, 'processor.js'), processorSource);
  writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {};\n');
};

const reexportFixtureProcessor = `module.exports = require(${JSON.stringify(
  processorFixturePath
)});\n`;

const createTempRoot = (): string =>
  mkdtempSync(path.join(tmpdir(), 'wyw-processor-lookup-'));

const createPackageFixture = (
  packageName: string,
  processorSource = reexportFixtureProcessor
): string => {
  const root = createTempRoot();
  writeProcessorPackage(
    path.join(root, 'node_modules', packageName),
    packageName,
    processorSource
  );

  return root;
};

const workspacePackageRoot = (packageName: string): string =>
  path.resolve(path.dirname(require.resolve(packageName)), '..');

/**
 * Installs a physically separate copy of `@wyw-in-js/processor-utils` under
 * `root/node_modules`, as a package manager does when a processor package
 * pins a different version than the one `@wyw-in-js/transform` uses.
 */
const installSecondProcessorUtilsCopy = (root: string): void => {
  const scopeDir = path.join(root, 'node_modules', '@wyw-in-js');
  const copyDir = path.join(scopeDir, 'processor-utils');
  const originalDir = workspacePackageRoot('@wyw-in-js/processor-utils');

  mkdirSync(copyDir, { recursive: true });
  copyFileSync(
    path.join(originalDir, 'package.json'),
    path.join(copyDir, 'package.json')
  );
  cpSync(path.join(originalDir, 'esm'), path.join(copyDir, 'esm'), {
    recursive: true,
  });
  symlinkSync(
    workspacePackageRoot('@wyw-in-js/shared'),
    path.join(scopeDir, 'shared'),
    'dir'
  );
};

describe('getProcessorForImport', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    tempRoots.splice(0).forEach((root) => {
      rmSync(root, { force: true, recursive: true });
    });
  });

  it('skips package lookup for clearly non-package sources without tagResolver', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');

    const [processor, tagSource] = getProcessorForImport(
      {
        imported: 'css',
        source: '@/styles/textStyles',
      },
      null,
      { tagResolver: undefined }
    );

    expect(processor).toBeNull();
    expect(tagSource).toEqual({
      imported: 'css',
      source: '@/styles/textStyles',
    });
    expect(findPackageJSONSpy).not.toHaveBeenCalled();
  });

  it('still lets tagResolver resolve clearly non-package sources', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const tagResolver = jest.fn(() => processorFixturePath);

    const [processor] = getProcessorForImport(
      {
        imported: 'css',
        source: '@/styles/local-processor',
      },
      '/tmp/source.tsx',
      { tagResolver }
    );

    expect(processor?.name).toBe('CssProcessor');
    expect(tagResolver).toHaveBeenCalledWith(
      '@/styles/local-processor',
      'css',
      expect.objectContaining({
        sourceFile: '/tmp/source.tsx',
      })
    );
    expect(findPackageJSONSpy).not.toHaveBeenCalled();
  });

  it('skips package lookup after a tagResolver miss on non-package sources', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const tagResolver = jest.fn(() => null);

    const [processor] = getProcessorForImport(
      {
        imported: 'css',
        source: './local-styles',
      },
      '/tmp/source.tsx',
      { tagResolver }
    );

    expect(processor).toBeNull();
    expect(tagResolver).toHaveBeenCalledTimes(1);
    expect(findPackageJSONSpy).not.toHaveBeenCalled();
  });

  it('keeps package-backed processor lookup behavior for bare package imports', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const packageName = 'test-package-lookup-contract';
    const root = createPackageFixture(packageName);
    tempRoots.push(root);

    const [processor] = getProcessorForImport(
      {
        imported: 'css',
        source: packageName,
      },
      path.join(root, 'entry.tsx'),
      { tagResolver: undefined }
    );

    expect(processor?.name).toBe('CssProcessor');
    expect(findPackageJSONSpy).toHaveBeenCalledWith(
      packageName,
      path.join(root, 'entry.tsx')
    );
  });

  it('skips a non-processor function export with a warning at lookup time', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const packageName = 'test-package-lookup-function-export';
    const root = createPackageFixture(
      packageName,
      'module.exports = { default: function notAProcessor() {} };\n'
    );
    tempRoots.push(root);
    const processorPath = path.join(
      root,
      'node_modules',
      packageName,
      'processor.js'
    );

    const [processor, , manifest] = getProcessorForImport(
      { imported: 'css', source: packageName },
      path.join(root, 'entry.tsx'),
      { tagResolver: undefined }
    );

    expect(processor).toBeNull();
    expect(manifest).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toContain(
      `[wyw-in-js] Invalid processor ${processorPath} for "css" from "${packageName}"`
    );
    expect(message).toContain(
      'default export must be a class extending BaseProcessor'
    );
    expect(message).toContain('"notAProcessor"');
    expect(message).toContain('The tag is skipped');
    expect(message).toContain('wyw-in-js 3.0');
  });

  it('skips a non-processor class returned by tagResolver with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const root = createTempRoot();
    tempRoots.push(root);
    const processorPath = path.join(root, 'not-a-processor.js');
    writeFileSync(
      processorPath,
      'class Helper { build() {} }\nmodule.exports = { default: Helper };\n'
    );

    const [processor] = getProcessorForImport(
      { imported: 'css', source: '@/styles/helper' },
      path.join(root, 'entry.tsx'),
      { tagResolver: () => processorPath }
    );

    expect(processor).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      `[wyw-in-js] Invalid processor ${processorPath} for "css" from "@/styles/helper"`
    );
  });

  it('skips a processor module without a default export with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const packageName = 'test-package-lookup-missing-default';
    const root = createPackageFixture(
      packageName,
      `module.exports = require(${JSON.stringify(
        processorFixturePath
      )}).default;\n`
    );
    tempRoots.push(root);

    const [processor] = getProcessorForImport(
      { imported: 'css', source: packageName },
      path.join(root, 'entry.tsx'),
      { tagResolver: undefined }
    );

    expect(processor).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('got undefined');
  });

  it('warns about an invalid processor once per package and tag', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const packageName = 'test-package-lookup-warn-once';
    const root = createTempRoot();
    tempRoots.push(root);
    const packageDir = path.join(root, 'node_modules', packageName);
    writeProcessorPackage(
      packageDir,
      packageName,
      'module.exports = { default: function notAProcessor() {} };\n'
    );
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        main: './index.js',
        'wyw-in-js': {
          tags: { css: './processor.js', styled: './processor.js' },
        },
      })
    );

    const lookupFrom = (importer: string, imported: string) =>
      getProcessorForImport({ imported, source: packageName }, importer, {
        tagResolver: undefined,
      })[0];

    expect(lookupFrom(path.join(root, 'a', 'entry.tsx'), 'css')).toBeNull();
    expect(lookupFrom(path.join(root, 'b', 'entry.tsx'), 'css')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    expect(lookupFrom(path.join(root, 'a', 'entry.tsx'), 'styled')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1][0]).toContain(
      `for "styled" from "${packageName}"`
    );
  });

  it('recognizes a BaseProcessor subclass from another copy of processor-utils', () => {
    const packageName = 'test-package-lookup-second-utils-copy';
    const root = createPackageFixture(
      packageName,
      [
        "const { TaggedTemplateProcessor } = require('@wyw-in-js/processor-utils');",
        'class SecondCopyCssProcessor extends TaggedTemplateProcessor {',
        '  get asSelector() { return this.className; }',
        '  get value() { return this.astService.stringLiteral(this.className); }',
        '  addInterpolation() {}',
        '  doEvaltimeReplacement() {}',
        '  doRuntimeReplacement() {}',
        '  extractRules() { return {}; }',
        '}',
        'module.exports = { default: SecondCopyCssProcessor };',
        '',
      ].join('\n')
    );
    tempRoots.push(root);
    installSecondProcessorUtilsCopy(root);

    const [processor] = getProcessorForImport(
      { imported: 'css', source: packageName },
      path.join(root, 'entry.tsx'),
      { tagResolver: undefined }
    );

    expect(processor?.name).toBe('SecondCopyCssProcessor');
    // The class really comes from a different copy of processor-utils.
    expect(processor?.prototype instanceof BaseProcessor).toBe(false);
  });

  it('resolves processors per importer when packages resolve different versions', () => {
    const packageName = 'test-package-lookup-two-versions';
    const root = createTempRoot();
    tempRoots.push(root);
    const appA = path.join(root, 'packages', 'app-a');
    const appB = path.join(root, 'packages', 'app-b');
    writeProcessorPackage(
      path.join(root, 'node_modules', packageName),
      packageName,
      reexportFixtureProcessor
    );
    writeProcessorPackage(
      path.join(appB, 'node_modules', packageName),
      packageName,
      [
        `const { default: CssProcessor } = require(${JSON.stringify(
          processorFixturePath
        )});`,
        'class CssProcessorV2 extends CssProcessor {}',
        'module.exports = { default: CssProcessorV2 };',
        '',
      ].join('\n')
    );

    const lookupFrom = (importer: string) =>
      getProcessorForImport(
        { imported: 'css', source: packageName },
        importer,
        { tagResolver: undefined }
      )[0];

    expect(lookupFrom(path.join(appA, 'src', 'entry.tsx'))?.name).toBe(
      'CssProcessor'
    );
    expect(lookupFrom(path.join(appB, 'src', 'entry.tsx'))?.name).toBe(
      'CssProcessorV2'
    );
    expect(lookupFrom(path.join(appA, 'src', 'other.tsx'))?.name).toBe(
      'CssProcessor'
    );
  });

  it('reuses the lookup for importers in the same directory', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const packageName = 'test-package-lookup-same-directory';
    const root = createPackageFixture(packageName);
    tempRoots.push(root);

    const lookupFrom = (importer: string) =>
      getProcessorForImport(
        { imported: 'css', source: packageName },
        importer,
        { tagResolver: undefined }
      )[0];

    expect(lookupFrom(path.join(root, 'a.tsx'))?.name).toBe('CssProcessor');
    expect(lookupFrom(path.join(root, 'b.tsx'))?.name).toBe('CssProcessor');
    expect(findPackageJSONSpy).toHaveBeenCalledTimes(1);
  });
});
