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
    expect(
      findPackageJSON('self-package', path.join(root, 'lib/c.ts'))
    ).toBeUndefined();
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
