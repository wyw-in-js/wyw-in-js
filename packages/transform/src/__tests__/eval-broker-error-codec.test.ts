import * as babel from '@babel/core';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker, getEvalBroker } from '../eval/broker';
import { shaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';

const createServices = (root: string, filename: string) => {
  const pluginOptions = loadWywOptions({
    configFile: false,
    rules: [
      {
        test: () => true,
        action: shaker,
      },
    ],
    babelOptions: {
      babelrc: false,
      configFile: false,
    },
  });
  const cache = new TransformCacheCollection();
  return withDefaultServices({
    babel,
    cache,
    cacheEpoch: cache.getCurrentEpoch(),
    options: {
      root,
      filename,
      pluginOptions,
    },
  });
};

describe('eval broker error codec', () => {
  it('rejects an evaluation with the name and the cause chain of the error thrown by evaluated code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-error-codec-'));
    const entry = join(root, 'entry.js');
    const source = [
      'const fail = () => {',
      "  throw new TypeError('outer', {",
      "    cause: new RangeError('middle', { cause: new Error('inner') }),",
      '  });',
      '};',
      'export const __wywPreval = { value: fail() };',
    ].join('\n');
    writeFileSync(entry, source);

    const services = createServices(root, entry);
    const scope = {};
    services.evalBrokerScope = scope;
    const resolver = async () => null;

    try {
      const broker = getEvalBroker(services, resolver, 'error-codec');
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        source
      );

      const error = await broker.evaluate(entrypoint, services).then(
        () => undefined,
        (reason: unknown) => reason
      );

      expect(error).toBeInstanceOf(Error);
      const outer = error as Error;
      expect(outer.message).toBe('outer');
      expect(outer.name).toBe('TypeError');

      const middle = outer.cause as Error | undefined;
      expect(middle?.message).toBe('middle');
      expect(middle?.name).toBe('RangeError');

      const inner = middle?.cause as Error | undefined;
      expect(inner?.message).toBe('inner');
    } finally {
      disposeEvalBroker(scope);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
