import { readFileSync } from 'fs';
import { relative } from 'path';

import { globSync } from 'glob';

const MAX_LINES = 1000;

const LEGACY_OVERSIZED_FILES = new Map([
  ['packages/transform/src/eval/broker.ts', 3132],
  ['packages/transform/src/module.ts', 1482],
  [
    'packages/transform/src/transform/generators/rewriteOxcBarrelImports.ts',
    1452,
  ],
  ['packages/transform/src/utils/applyOxcProcessors/cleanupRemovals.ts', 1018],
  ['packages/transform/src/utils/collectOxcExportsAndImports.ts', 1380],
  ['packages/transform/src/utils/oxcPreevalTransforms.ts', 1632],
  ['packages/transform/src/utils/oxcShaker.ts', 1082],
]);

const files = globSync('packages/**/*.ts', {
  absolute: true,
  ignore: [
    '**/coverage/**',
    '**/dist/**',
    '**/esm/**',
    '**/lib/**',
    '**/node_modules/**',
    '**/types/**',
    '**/__fixtures__/**',
    '**/__tests__/**',
    '**/*.d.ts',
    '**/*.test.ts',
    '**/scripts/**',
  ],
});

const violations = [];

for (const file of files) {
  const relativeFile = relative(process.cwd(), file);
  const content = readFileSync(file, 'utf8');
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lineCount =
    normalizedContent === ''
      ? 0
      : normalizedContent.split('\n').length -
        (normalizedContent.endsWith('\n') ? 1 : 0);
  const legacyLimit = LEGACY_OVERSIZED_FILES.get(relativeFile);
  const allowedLines = legacyLimit ?? MAX_LINES;

  if (lineCount > allowedLines) {
    violations.push({
      allowedLines,
      lineCount,
      relativeFile,
    });
  }
}

if (violations.length > 0) {
  console.error('Production TypeScript files exceed the line-count guard:');
  for (const violation of violations) {
    console.error(
      `- ${violation.relativeFile}: ${violation.lineCount} lines ` +
        `(allowed ${violation.allowedLines})`
    );
  }

  console.error(
    `New production .ts files must stay at or below ${MAX_LINES} lines. ` +
      'The temporary legacy limits should shrink as the static-eval refactor splits the existing monoliths.'
  );
  process.exit(1);
}
