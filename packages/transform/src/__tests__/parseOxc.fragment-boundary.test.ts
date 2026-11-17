import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const sourceRoot = join(__dirname, '..');

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectSourceFiles(path);
    }

    return entry.name.endsWith('.ts') ? [path] : [];
  });

describe('static expression fragment parsing boundary', () => {
  const fragmentBuilders = collectSourceFiles(sourceRoot)
    .filter((file) => readFileSync(file, 'utf8').includes('__wyw_static_value'))
    .map((file) => relative(sourceRoot, file).split('\\').join('/'))
    .sort();

  it('builds static expression texts in known places only', () => {
    expect(fragmentBuilders).toEqual([
      'transform/generators/resolveStaticOxcValues/staticExpression.ts',
      'utils/collectOxcTemplateDependencies/staticExpressionEvaluation.ts',
    ]);
  });

  it('parses static expression texts through the fragment entry', () => {
    const offenders = fragmentBuilders.filter(
      (file) =>
        !readFileSync(join(sourceRoot, file), 'utf8').includes(
          'parseOxcFragmentProgram('
        )
    );

    expect(offenders).toEqual([]);
  });
});
