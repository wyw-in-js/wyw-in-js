/* eslint-disable no-restricted-syntax */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type {
  BindingPattern,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  ExportSpecifier,
  ImportDeclaration,
  ModuleExportName,
  Node,
  Program,
  Statement,
  VariableDeclaration,
  VariableDeclarator,
} from 'oxc-parser';

import { recordPipelineUncachedParse } from '../debug/pipelineTelemetry';

import { parseOxcSync } from './parseOxc';

type Replacement = {
  end: number;
  start: number;
  value: string;
};

type SourceMap = {
  file?: string;
  mappings: string;
  names: string[];
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: string[];
  version: number;
  x_google_ignoreList?: number[];
};

export type OxcEmitResult = {
  code: string;
  map?: SourceMap;
};

type AnyNode = Node & Record<string, unknown>;
type OxcTransformResult = {
  code: string;
  errors: { message: string; severity: string }[];
  map?: SourceMap;
};

type OxcTransform = (
  filename: string,
  sourceText: string,
  options?: Record<string, unknown> | null
) => OxcTransformResult;

type OxcTransformModule = {
  transform?: OxcTransform;
  transformSync?: OxcTransform;
};

let oxcTransform: OxcTransform | null = null;

const getCommonJsFilename = (): string | null =>
  typeof __filename === 'string' ? __filename : null;

const getCurrentFilenameFromStack = (): string | null => {
  const { stack } = new Error();
  const match = stack?.match(
    /(?:\(|\s)(file:\/\/[^)\s]+\/oxcEmit\.(?:js|ts)|\/[^)\s]+\/oxcEmit\.(?:js|ts)):\d+:\d+/
  );
  const filename = match?.[1];

  if (!filename) {
    return null;
  }

  return filename.startsWith('file://') ? fileURLToPath(filename) : filename;
};

const getNativeBindingCandidates = (): string[] => {
  const { arch, platform } = process;

  if (platform === 'darwin') {
    return arch === 'arm64'
      ? [
          './transform.darwin-universal.node',
          '@oxc-transform/binding-darwin-universal',
          './transform.darwin-arm64.node',
          '@oxc-transform/binding-darwin-arm64',
        ]
      : [
          './transform.darwin-universal.node',
          '@oxc-transform/binding-darwin-universal',
          './transform.darwin-x64.node',
          '@oxc-transform/binding-darwin-x64',
        ];
  }

  if (platform === 'win32') {
    if (arch === 'arm64') {
      return [
        './transform.win32-arm64-msvc.node',
        '@oxc-transform/binding-win32-arm64-msvc',
      ];
    }

    return [
      './transform.win32-x64-msvc.node',
      '@oxc-transform/binding-win32-x64-msvc',
    ];
  }

  if (platform === 'linux') {
    if (arch === 'arm64') {
      return [
        './transform.linux-arm64-gnu.node',
        '@oxc-transform/binding-linux-arm64-gnu',
        './transform.linux-arm64-musl.node',
        '@oxc-transform/binding-linux-arm64-musl',
      ];
    }

    if (arch === 'arm') {
      return [
        './transform.linux-arm-gnueabihf.node',
        '@oxc-transform/binding-linux-arm-gnueabihf',
        './transform.linux-arm-musleabihf.node',
        '@oxc-transform/binding-linux-arm-musleabihf',
      ];
    }

    if (arch === 's390x') {
      return [
        './transform.linux-s390x-gnu.node',
        '@oxc-transform/binding-linux-s390x-gnu',
      ];
    }

    if (arch === 'riscv64') {
      return [
        './transform.linux-riscv64-gnu.node',
        '@oxc-transform/binding-linux-riscv64-gnu',
        './transform.linux-riscv64-musl.node',
        '@oxc-transform/binding-linux-riscv64-musl',
      ];
    }

    return [
      './transform.linux-x64-gnu.node',
      '@oxc-transform/binding-linux-x64-gnu',
      './transform.linux-x64-musl.node',
      '@oxc-transform/binding-linux-x64-musl',
    ];
  }

  if (platform === 'freebsd') {
    return [
      './transform.freebsd-x64.node',
      '@oxc-transform/binding-freebsd-x64',
    ];
  }

  if (platform === 'android') {
    return [
      './transform.android-arm64.node',
      '@oxc-transform/binding-android-arm64',
    ];
  }

  return [];
};

const loadNativeOxcTransform = (
  requireFromHere: NodeRequire
): OxcTransformModule => {
  const requireFromOxc = createRequire(
    requireFromHere.resolve('oxc-transform')
  );
  const errors: unknown[] = [];

  for (const candidate of [
    ...getNativeBindingCandidates(),
    './transform.wasi.cjs',
    '@oxc-transform/binding-wasm32-wasi',
  ]) {
    try {
      return requireFromOxc(candidate) as OxcTransformModule;
    } catch (error) {
      errors.push(error);
    }
  }

  throw new Error('[wyw-in-js] Cannot load oxc-transform native binding.', {
    cause: errors,
  });
};

const loadOxcTransform = (): OxcTransform => {
  if (!oxcTransform) {
    const filename =
      getCommonJsFilename() ??
      getCurrentFilenameFromStack() ??
      `${process.cwd()}/package.json`;
    const requireFromHere = createRequire(filename);
    let oxcTransformModule: OxcTransformModule;

    try {
      oxcTransformModule = requireFromHere(
        'oxc-transform'
      ) as OxcTransformModule;
    } catch {
      oxcTransformModule = loadNativeOxcTransform(requireFromHere);
    }

    const syncTransform =
      oxcTransformModule.transformSync ?? oxcTransformModule.transform;
    if (!syncTransform) {
      throw new Error(
        '[wyw-in-js] Loaded oxc-transform module does not expose a sync transform API.'
      );
    }

    oxcTransform = syncTransform;
  }

  return oxcTransform;
};

const applyReplacements = (
  code: string,
  replacements: Replacement[]
): string => {
  let result = code;
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        replacement.value +
        result.slice(replacement.end);
    });

  return result;
};

const parseJsModule = (code: string, filename: string): Program => {
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(filename, code, {
      astType: 'js',
      range: true,
      sourceType: 'module',
    });
  } catch (error) {
    recordPipelineUncachedParse(filename, code, 'module', 'js', true);
    throw error;
  }
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    recordPipelineUncachedParse(filename, code, 'module', 'js', true);
    throw new Error(fatalError.message);
  }
  recordPipelineUncachedParse(filename, code, 'module', 'js', false);

  return parsed.program as Program;
};

const tryParseJsModule = (code: string, filename: string): Program | null => {
  try {
    return parseJsModule(code, filename);
  } catch {
    return null;
  }
};

const getLang = (filename: string): 'js' | 'jsx' | 'ts' | 'tsx' | 'dts' => {
  if (filename.endsWith('.tsx')) return 'tsx';
  if (filename.endsWith('.ts') || filename.endsWith('.mts')) return 'ts';
  if (filename.endsWith('.jsx')) return 'jsx';
  return 'js';
};

const getCurrentNodeTarget = (): string => {
  const [major] = process.versions.node.split('.');
  return `node${major}`;
};

const assertOxcSuccess = (
  errors: { message: string; severity: string }[]
): void => {
  const fatalErrors = errors.filter((error) => error.severity === 'Error');
  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map((error) => error.message).join('\n'));
  }
};

export const stripTypesAndJsxWithOxc = (
  code: string,
  filename: string,
  options: { sourcemap?: boolean } = {}
): OxcEmitResult => {
  const result = loadOxcTransform()(filename, code, {
    jsx: {
      runtime: 'automatic',
    },
    lang: getLang(filename),
    sourceType: 'module',
    sourcemap: options.sourcemap ?? false,
    target: getCurrentNodeTarget(),
    typescript: {
      allowNamespaces: true,
      onlyRemoveTypeImports: false,
      removeClassFieldsWithoutInitializer: true,
    },
  });

  assertOxcSuccess(result.errors);

  return {
    code: result.code,
    map: result.map,
  };
};

const nameFromModuleExport = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const propertyAccess = (name: string): string =>
  /^[$A-Z_a-z][$\w]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;

const exportAssignment = (exported: string, local: string): string =>
  `exports${propertyAccess(exported)} = ${local};`;

const exportGetter = (exported: string, value: string): string =>
  [
    `Object.defineProperty(exports, ${JSON.stringify(exported)}, {`,
    '  enumerable: true,',
    '  get: function () {',
    `    return ${value};`,
    '  }',
    '});',
  ].join('\n');

const defaultInteropExpression = (value: string): string =>
  `${value} && ${value}.__esModule ? ${value}.default : ("default" in Object(${value}) ? ${value}.default : ${value})`;

const collectBindingNames = (
  pattern: BindingPattern | Node | null | undefined
): string[] => {
  if (!pattern) {
    return [];
  }

  if (pattern.type === 'Identifier') {
    return [pattern.name];
  }

  if (pattern.type === 'RestElement') {
    return collectBindingNames(pattern.argument);
  }

  if (pattern.type === 'AssignmentPattern') {
    return collectBindingNames(pattern.left);
  }

  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectBindingNames(property.argument)
        : collectBindingNames(property.value)
    );
  }

  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap((element) => collectBindingNames(element));
  }

  return [];
};

const declarationBindings = (node: Node | null | undefined): string[] => {
  if (!node) {
    return [];
  }

  if (node.type === 'VariableDeclaration') {
    return node.declarations.flatMap((declarator) =>
      collectBindingNames(declarator.id)
    );
  }

  if (
    (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
    node.id
  ) {
    return [node.id.name];
  }

  return [];
};

const emitImportDeclaration = (
  node: ImportDeclaration,
  index: number
): string => {
  const source = JSON.stringify(node.source.value);
  if (node.specifiers.length === 0) {
    return `require(${source});`;
  }

  const temp = `__wyw_import_${index}`;
  const lines = [`const ${temp} = require(${source});`];

  node.specifiers.forEach((specifier) => {
    if (specifier.type === 'ImportNamespaceSpecifier') {
      lines.push(`const ${specifier.local.name} = ${temp};`);
      return;
    }

    if (specifier.type === 'ImportDefaultSpecifier') {
      lines.push(
        `const ${specifier.local.name} = ${defaultInteropExpression(temp)};`
      );
      return;
    }

    const imported = nameFromModuleExport(specifier.imported);
    const value =
      imported === 'default'
        ? defaultInteropExpression(temp)
        : `${temp}${propertyAccess(imported)}`;
    lines.push(`const ${specifier.local.name} = ${value};`);
  });

  return lines.join('\n');
};

const variableDeclaratorCode = (
  code: string,
  declarator: VariableDeclarator,
  exportedNames: string[]
): string => {
  if (declarator.id.type !== 'Identifier') {
    return code.slice(declarator.start, declarator.end);
  }

  const binding = declarator.id.name;
  const init = declarator.init
    ? code.slice(declarator.init.start, declarator.init.end)
    : 'undefined';
  const exported = exportedNames.includes(binding);
  const value = exported ? `exports${propertyAccess(binding)} = ${init}` : init;

  return `${binding} = ${value}`;
};

const emitVariableExport = (
  code: string,
  node: VariableDeclaration
): string => {
  const bindings = node.declarations.flatMap((declarator) =>
    collectBindingNames(declarator.id)
  );
  const allSimple = node.declarations.every(
    (declarator) => declarator.id.type === 'Identifier'
  );

  if (allSimple) {
    return node.declarations
      .map(
        (declarator) =>
          `${node.kind} ${variableDeclaratorCode(code, declarator, bindings)};`
      )
      .join('\n');
  }

  const declaration = code.slice(node.start, node.end);
  const assignments = bindings.map((binding) =>
    exportAssignment(binding, binding)
  );
  return [declaration, ...assignments].join('\n');
};

const emitVariableDeclaration = (
  code: string,
  node: VariableDeclaration
): string => {
  if (node.declarations.length <= 1) {
    return code.slice(node.start, node.end);
  }

  return node.declarations
    .map(
      (declarator) =>
        `${node.kind} ${code.slice(declarator.start, declarator.end)};`
    )
    .join('\n');
};

const containsSyntaxThatRequiresOxcStrip = (node: unknown): boolean => {
  if (!node || typeof node !== 'object') {
    return false;
  }

  const record = node as Record<string, unknown>;
  if (typeof record.type === 'string') {
    if (record.type.startsWith('TS') || record.type.startsWith('JSX')) {
      return true;
    }
  }

  return Object.values(record).some((value) => {
    if (!value || typeof value !== 'object') {
      return false;
    }

    if (Array.isArray(value)) {
      return value.some(containsSyntaxThatRequiresOxcStrip);
    }

    return containsSyntaxThatRequiresOxcStrip(value);
  });
};

const collectPredeclaredExports = (statement: Statement): string[] => {
  if (statement.type === 'ExportNamedDeclaration') {
    if (statement.declaration) {
      return declarationBindings(statement.declaration);
    }

    return statement.specifiers.map((specifier: ExportSpecifier) =>
      nameFromModuleExport(specifier.exported)
    );
  }

  if (statement.type === 'ExportDefaultDeclaration') {
    return ['default'];
  }

  return [];
};

const stripLegacyCodegenTrailingCommas = (code: string): string =>
  code.replace(/,\n(\s*})/g, '\n$1');

const stripLeadingBlankLines = (code: string): string =>
  code.replace(/^(?:[ \t]*\n)+/, '');

const stripExportPrefix = (
  code: string,
  node: ExportNamedDeclaration
): string =>
  node.declaration
    ? code.slice(node.declaration.start, node.declaration.end)
    : '';

const emitNamedExportDeclaration = (
  code: string,
  node: ExportNamedDeclaration,
  importIndex: number
): string => {
  if (node.source) {
    const source = JSON.stringify(node.source.value);
    const temp = `__wyw_reexport_${importIndex}`;
    const lines = [`const ${temp} = require(${source});`];
    node.specifiers.forEach((specifier) => {
      const local = nameFromModuleExport(specifier.local);
      const exported = nameFromModuleExport(specifier.exported);
      const value =
        local === 'default'
          ? defaultInteropExpression(temp)
          : `${temp}${propertyAccess(local)}`;
      lines.push(
        [
          `Object.defineProperty(exports, ${JSON.stringify(exported)}, {`,
          `  enumerable: true,`,
          `  get: function () {`,
          `    return ${value};`,
          `  }`,
          `});`,
        ].join('\n')
      );
    });
    return lines.join('\n');
  }

  if (node.declaration) {
    if (node.declaration.type === 'VariableDeclaration') {
      return emitVariableExport(code, node.declaration);
    }

    const declaration = stripExportPrefix(code, node);
    const assignments = declarationBindings(node.declaration).map((binding) =>
      exportAssignment(binding, binding)
    );
    return [declaration, ...assignments].join('\n');
  }

  return node.specifiers
    .map((specifier: ExportSpecifier) => {
      const local = nameFromModuleExport(specifier.local);
      const exported = nameFromModuleExport(specifier.exported);
      return exportGetter(exported, local);
    })
    .join('\n');
};

const defaultDeclarationName = (node: Node): string | null => {
  if (
    (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
    node.id
  ) {
    return node.id.name;
  }

  return null;
};

const emitDefaultExportDeclaration = (
  code: string,
  node: ExportDefaultDeclaration
): string => {
  const declaration = node.declaration as Node;
  const declarationCode = code.slice(declaration.start, declaration.end);
  const declarationName = defaultDeclarationName(declaration);

  if (declarationName) {
    return `${declarationCode}\nexports.default = ${declarationName};`;
  }

  if (
    declaration.type === 'FunctionDeclaration' ||
    declaration.type === 'ClassDeclaration'
  ) {
    return `const _default = ${declarationCode};\nexports.default = _default;`;
  }

  return `exports.default = ${declarationCode};`;
};

const emitExportAllDeclaration = (node: Statement, index: number): string => {
  const record = node as AnyNode;
  const source = JSON.stringify((record.source as { value: string }).value);
  const temp = `__wyw_reexport_all_${index}`;

  if ('exported' in record && record.exported) {
    const exported = nameFromModuleExport(record.exported as ModuleExportName);
    return `exports${propertyAccess(exported)} = require(${source});`;
  }

  return [
    `const ${temp} = require(${source});`,
    `Object.keys(${temp}).forEach((key) => {`,
    `  if (key !== "default" && key !== "__esModule") exports[key] = ${temp}[key];`,
    `});`,
  ].join('\n');
};

export const emitOxcCommonJS = (
  code: string,
  filename: string
): OxcEmitResult => {
  const parsedOriginal = tryParseJsModule(code, filename);
  const canUseOriginal =
    parsedOriginal && !containsSyntaxThatRequiresOxcStrip(parsedOriginal);
  const source = canUseOriginal
    ? { code, program: parsedOriginal }
    : (() => {
        const stripped = stripTypesAndJsxWithOxc(code, filename);
        return {
          code: stripped.code,
          program: parseJsModule(stripped.code, filename),
        };
      })();

  const replacements: Replacement[] = [];
  let needsEsModuleMarker = false;
  const predeclaredExports = new Set<string>();

  source.program.body.forEach((statement, index) => {
    const node = statement as Statement;
    if (node.type === 'ImportDeclaration') {
      replacements.push({
        end: node.end,
        start: node.start,
        value: emitImportDeclaration(node, index),
      });
      return;
    }

    if (node.type === 'ExportNamedDeclaration') {
      needsEsModuleMarker = true;
      collectPredeclaredExports(node).forEach((name) =>
        predeclaredExports.add(name)
      );
      replacements.push({
        end: node.end,
        start: node.start,
        value: emitNamedExportDeclaration(source.code, node, index),
      });
      return;
    }

    if (node.type === 'ExportDefaultDeclaration') {
      needsEsModuleMarker = true;
      collectPredeclaredExports(node).forEach((name) =>
        predeclaredExports.add(name)
      );
      replacements.push({
        end: node.end,
        start: node.start,
        value: emitDefaultExportDeclaration(source.code, node),
      });
      return;
    }

    if (node.type === 'ExportAllDeclaration') {
      needsEsModuleMarker = true;
      replacements.push({
        end: node.end,
        start: node.start,
        value: emitExportAllDeclaration(node, index),
      });
      return;
    }

    if (node.type === 'VariableDeclaration' && node.declarations.length > 1) {
      replacements.push({
        end: node.end,
        start: node.start,
        value: emitVariableDeclaration(source.code, node),
      });
    }
  });

  const commonjs = stripLegacyCodegenTrailingCommas(
    applyReplacements(source.code, replacements)
  );
  const normalizedCommonjs = stripLeadingBlankLines(commonjs);
  const predeclared = [...predeclaredExports]
    .map((name) => `exports${propertyAccess(name)} = void 0;`)
    .join('\n');
  const preamble = needsEsModuleMarker
    ? [
        '"use strict";',
        '',
        'Object.defineProperty(exports, "__esModule", {',
        '  value: true',
        '});',
        predeclared,
        '',
      ]
        .filter((line, index) => predeclared || index !== 5)
        .join('\n')
    : '"use strict";\n';

  return {
    code: `${preamble}${normalizedCommonjs}`,
  };
};
