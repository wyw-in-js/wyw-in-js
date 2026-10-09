import type { Program } from 'oxc-parser';

import {
  registerPipelineTelemetryReporter,
  runWithPipelineTelemetry,
  type PipelineTelemetrySummary,
} from '../debug/pipelineTelemetry';
import { parseFile } from '../transform/Entrypoint.helpers';
import { isStaticallyEvaluatableModule } from '../transform/isStaticallyEvaluatableModule';
import { analyzeOxcBarrelFile } from '../transform/oxcBarrelManifest';
import { EventEmitter } from '../utils/EventEmitter';
import { emitOxcCommonJS } from '../utils/oxcEmit';
import { appendOxcWywPreval } from '../utils/oxcPreevalStage';
import { parseOxcCached } from '../utils/parseOxc';

const collectParseTelemetry = async (
  filename: string,
  run: () => void
): Promise<PipelineTelemetrySummary['parse']> => {
  const emitter = new EventEmitter(
    () => {},
    () => 0,
    () => {}
  );
  const summaries: PipelineTelemetrySummary[] = [];
  const unregister = registerPipelineTelemetryReporter(emitter, (summary) =>
    summaries.push(summary)
  );
  try {
    await runWithPipelineTelemetry(emitter, () => ({ filename }), run);
  } finally {
    unregister();
  }

  expect(summaries).toHaveLength(1);
  return summaries[0].parse;
};

describe('single cached parse entry', () => {
  it('accepts JSX in .js files wherever the pipeline parses them', () => {
    const filename = '/project/single-entry-jsx.js';
    const code = [
      "export { tone } from './tone';",
      "export const color = 'red';",
      'export const Badge = () => <span className="badge" />;',
    ].join('\n');

    expect(isStaticallyEvaluatableModule(code, filename)).toBe(false);
    expect(appendOxcWywPreval(code, filename, ['color'])).toBe(
      `${code}\nexport const __wywPreval = { color: color };`
    );
    expect(analyzeOxcBarrelFile(code, filename)).toMatchObject({
      complete: false,
      kind: 'barrel',
      reexports: [
        { exported: 'tone', imported: 'tone', kind: 'named', source: './tone' },
      ],
    });
    expect(
      (parseFile(undefined, filename, code) as Program).body.map(
        ({ type }) => type
      )
    ).toEqual([
      'ExportNamedDeclaration',
      'ExportNamedDeclaration',
      'ExportNamedDeclaration',
    ]);
  });

  it('serves every former direct-parse site from one parse of the content', async () => {
    const filename = '/project/single-entry-reuse.js';
    const code = "export const singleEntryReuse = 'shared';";

    const parse = await collectParseTelemetry(filename, () => {
      parseOxcCached(filename, code, 'module');
      isStaticallyEvaluatableModule(code, filename);
      appendOxcWywPreval(code, filename, []);
      analyzeOxcBarrelFile(code, filename);
      emitOxcCommonJS(code, filename);
    });

    expect(parse).toMatchObject({
      allRequests: 5,
      cacheHits: 4,
      cacheMisses: 1,
      parserAttempts: 1,
      uncachedRequests: 0,
    });
  });

  it('gives parseFile callers a fresh program that cannot corrupt the cache', async () => {
    const filename = '/project/single-entry-owned.js';
    const code = [
      "export const singleEntryOwned = 'owned';",
      'export const OwnedBadge = () => <span />;',
    ].join('\n');
    const cachedBefore = parseOxcCached(filename, code, 'module').program;
    const bodyBefore = [...cachedBefore.body];

    const parse = await collectParseTelemetry(filename, () => {
      const owned = parseFile(undefined, filename, code) as Program;
      expect(owned).not.toBe(cachedBefore);
      expect(parseFile(undefined, filename, code)).not.toBe(owned);
      owned.body.splice(0, owned.body.length);
    });

    const cachedAfter = parseOxcCached(filename, code, 'module').program;
    expect(cachedAfter).toBe(cachedBefore);
    expect(cachedAfter.body).toEqual(bodyBefore);
    expect(cachedAfter.body).toHaveLength(2);
    expect(parse).toMatchObject({
      allRequests: 2,
      cachedRequests: 0,
      jsxFallbackAttempts: 2,
      parserAttempts: 4,
      uncachedRequests: 2,
    });
    expect(parse.revisions).toEqual([
      expect.objectContaining({
        kind: 'uncached',
        parserKey: 'oxc:module:js:js:r1:j1',
        requests: 2,
      }),
    ]);
  });

  it('keeps a mutated parseFile result out of later cached parses', () => {
    const filename = '/project/single-entry-first.ts';
    const code = 'export const singleEntryFirst: number = 1;';

    const owned = parseFile(undefined, filename, code) as Program;
    owned.body.splice(0, owned.body.length);

    expect(parseOxcCached(filename, code, 'module').program.body).toHaveLength(
      1
    );
  });

  it('takes the preval source type from an existing script parse', async () => {
    const filename = '/project/single-entry-script.js';
    const code = "exports.singleEntryScript = 'script';";

    const parse = await collectParseTelemetry(filename, () => {
      parseOxcCached(filename, code, 'unambiguous');
      expect(appendOxcWywPreval(code, filename, ['singleEntryScript'])).toBe(
        `${code}\nexports.__wywPreval = { singleEntryScript: singleEntryScript };`
      );
    });

    expect(parse).toMatchObject({
      cacheHits: 1,
      cacheMisses: 1,
      parserAttempts: 1,
    });
  });
});
