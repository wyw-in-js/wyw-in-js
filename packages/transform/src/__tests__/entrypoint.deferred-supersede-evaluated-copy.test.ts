import fs from 'fs';
import os from 'os';
import path from 'path';

import * as babel from '@babel/core';

import { logger } from '@wyw-in-js/shared';
import type { StrictOptions } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { shaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { loadAndParse } from '../transform/Entrypoint.helpers';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const pluginOptions: StrictOptions = {
  babelOptions: {
    babelrc: false,
    configFile: false,
  },
  displayName: false,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  rules: [{ test: () => true, action: shaker }],
};

const createServices = (
  cache: TransformCacheCollection,
  filename: string
): Services => ({
  babel,
  cache,
  emitWarning: jest.fn(),
  loadAndParseFn: loadAndParse,
  log: logger,
  eventEmitter: EventEmitter.dummy,
  options: {
    filename,
    pluginOptions,
  },
});

// While `dep` is processed for `parent`, a consumer widening it can only defer
// the supersede, and an evaluation that loaded `dep` on demand publishes its
// evaluated copy over the cache entry. The deferred supersede then finds the
// copy instead of `dep` under its own name. It must replace the copy with the
// widened generation instead of aborting an entrypoint nobody superseded.
it('applies a deferred supersede over the evaluated copy of the entrypoint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-deferred-copy-'));
  const depFile = path.join(root, 'dep.ts');
  const parentFile = path.join(root, 'parent.ts');
  const otherFile = path.join(root, 'other.ts');
  fs.writeFileSync(
    depFile,
    `export const accent = 'red';\nexport const extra = 'blue';\n`
  );
  fs.writeFileSync(
    parentFile,
    `import { accent } from './dep';\nexport const a = accent;\n`
  );
  fs.writeFileSync(
    otherFile,
    `import { extra } from './dep';\nexport const b = extra;\n`
  );

  const cache = new TransformCacheCollection();
  const services = createServices(cache, parentFile);

  try {
    const parent = Entrypoint.createRoot(
      services,
      parentFile,
      ['__wywPreval'],
      undefined
    );
    const dep = parent.createChild(depFile, ['accent']);
    expect(dep).not.toBe('loop');
    if (dep === 'loop') {
      return;
    }
    dep.beginProcessing();

    const other = Entrypoint.createRoot(
      services,
      otherFile,
      ['__wywPreval'],
      undefined
    );
    expect(other.createChild(depFile, ['extra'])).toBe(dep);
    expect(dep.supersededWith).toBeNull();

    dep.setTransformResult({
      code: 'export const accent = "red";',
      metadata: null,
    });
    const copy = dep.createEvaluated(services);
    cache.add('entrypoints', depFile, copy);
    expect(cache.get('entrypoints', depFile)).toBe(copy);

    const successor = dep.applyDeferredSupersede(services);

    expect(successor).not.toBeNull();
    expect(dep.supersededWith).toBe(successor);
    expect(successor!.only).toEqual(['accent', 'extra']);
    expect(cache.get('entrypoints', depFile)).toBe(successor);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
