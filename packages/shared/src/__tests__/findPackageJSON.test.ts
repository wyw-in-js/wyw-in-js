import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { findPackageJSON } from '../findPackageJSON';

describe('findPackageJSON', () => {
  let root: string;

  const writeJSON = (file: string, content: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  };

  const installPackage = (packageDir: string, name: string) => {
    writeJSON(path.join(packageDir, 'package.json'), {
      name,
      main: './index.js',
    });
    writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {};\n');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wyw-find-pkg-')));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'lib'));
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'self-package' })
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('remembers lookups per requesting directory', () => {
    const packageJSON = path.join(root, 'package.json');

    // Not installed anywhere: resolution fails and the nearest package.json
    // is matched by name.
    expect(findPackageJSON('self-package', path.join(root, 'src/a.ts'))).toBe(
      packageJSON
    );

    writeFileSync(packageJSON, JSON.stringify({ name: 'renamed-package' }));

    expect(findPackageJSON('self-package', path.join(root, 'src/b.ts'))).toBe(
      packageJSON
    );
  });

  it('shares one lookup between the directories of a package', () => {
    const packageJSON = path.join(root, 'package.json');

    expect(findPackageJSON('self-package', path.join(root, 'src/a.ts'))).toBe(
      packageJSON
    );

    writeFileSync(packageJSON, JSON.stringify({ name: 'renamed-package' }));

    // Another directory of the same package without its own package.json,
    // node_modules, tsconfig.json or jsconfig.json resolves the same way.
    expect(findPackageJSON('self-package', path.join(root, 'lib/c.ts'))).toBe(
      packageJSON
    );
  });

  it('looks the package up again under a directory with its own package.json, node_modules, tsconfig.json or jsconfig.json', () => {
    const packageJSON = path.join(root, 'package.json');
    writeJSON(path.join(root, 'with-package-json', 'package.json'), {
      name: 'nested-package',
    });
    mkdirSync(path.join(root, 'with-node-modules', 'node_modules'), {
      recursive: true,
    });
    writeJSON(path.join(root, 'with-tsconfig', 'tsconfig.json'), {});
    writeJSON(path.join(root, 'with-jsconfig', 'jsconfig.json'), {});

    expect(findPackageJSON('self-package', path.join(root, 'src/a.ts'))).toBe(
      packageJSON
    );

    writeFileSync(packageJSON, JSON.stringify({ name: 'renamed-package' }));

    [
      'with-package-json',
      'with-node-modules',
      'with-tsconfig',
      'with-jsconfig',
    ].forEach((dir) => {
      expect(
        findPackageJSON('self-package', path.join(root, dir, 'src/d.ts'))
      ).toBeUndefined();
    });
  });

  it('resolves a package installed in a nested node_modules for the directories below it', () => {
    const packageName = 'wyw-find-pkg-nested-install';
    installPackage(path.join(root, 'node_modules', packageName), packageName);
    installPackage(
      path.join(root, 'app-b', 'node_modules', packageName),
      packageName
    );
    const rootPackageJSON = path.join(
      root,
      'node_modules',
      packageName,
      'package.json'
    );

    expect(
      findPackageJSON(packageName, path.join(root, 'app-a/src/a.ts'))
    ).toBe(rootPackageJSON);
    expect(
      findPackageJSON(packageName, path.join(root, 'app-a/other/b.ts'))
    ).toBe(rootPackageJSON);
    expect(
      findPackageJSON(packageName, path.join(root, 'app-b/src/c.ts'))
    ).toBe(
      path.join(root, 'app-b', 'node_modules', packageName, 'package.json')
    );
  });

  it("follows the tsconfig paths of the importer's directory", () => {
    // Bun, which runs these tests, resolves a bare specifier through the
    // `paths` of the nearest tsconfig.json; Node only walks node_modules.
    const packageName = 'wyw-find-pkg-tsconfig-paths';
    installPackage(path.join(root, 'node_modules', packageName), packageName);
    writeJSON(path.join(root, 'app', 'tsconfig.json'), {
      compilerOptions: {
        paths: { [packageName]: ['../ui/src/index.ts'] },
      },
    });
    writeJSON(path.join(root, 'ui', 'package.json'), { name: 'ui-package' });
    mkdirSync(path.join(root, 'ui', 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'ui', 'src', 'index.ts'),
      'export const ui = true;\n'
    );

    expect(
      findPackageJSON(packageName, path.join(root, 'other/src/a.ts'))
    ).toBe(path.join(root, 'node_modules', packageName, 'package.json'));
    expect(findPackageJSON(packageName, path.join(root, 'app/src/b.ts'))).toBe(
      path.join(root, 'ui', 'package.json')
    );
  });

  it('finds a package that resolves only through an import condition', () => {
    const packageName = 'wyw-find-pkg-import-only';
    const packageDir = path.join(root, 'node_modules', packageName);
    writeJSON(path.join(packageDir, 'package.json'), {
      name: packageName,
      exports: { '.': { import: './index.mjs' } },
    });
    writeFileSync(path.join(packageDir, 'index.mjs'), 'export default {};\n');

    expect(findPackageJSON(packageName, path.join(root, 'src/a.ts'))).toBe(
      path.join(packageDir, 'package.json')
    );
  });

  it('finds the nearest package.json for "."', () => {
    writeJSON(path.join(root, 'nested', 'package.json'), {
      name: 'nested-package',
    });

    expect(findPackageJSON('.', path.join(root, 'src/a.ts'))).toBe(
      path.join(root, 'package.json')
    );
    expect(findPackageJSON('.', path.join(root, 'lib/b.ts'))).toBe(
      path.join(root, 'package.json')
    );
    expect(findPackageJSON('.', path.join(root, 'nested/src/c.ts'))).toBe(
      path.join(root, 'nested', 'package.json')
    );
  });

  it('remembers failed lookups', () => {
    const filename = path.join(root, 'src/a.ts');

    expect(findPackageJSON('@/components/missing', filename)).toBeUndefined();

    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@/components/missing' })
    );

    expect(findPackageJSON('@/components/missing', filename)).toBeUndefined();
  });
});
