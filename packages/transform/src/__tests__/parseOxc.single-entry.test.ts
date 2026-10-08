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
    expect(parseFile(undefined, filename, code)).toBe(
      parseOxcCached(filename, code, 'module').program
    );
  });

  it('serves every former direct-parse site from one parse of the content', async () => {
    const filename = '/project/single-entry-reuse.js';
    const code = "export const singleEntryReuse = 'shared';";

    const parse = await collectParseTelemetry(filename, () => {
      parseOxcCached(filename, code, 'module');
      isStaticallyEvaluatableModule(code, filename);
      appendOxcWywPreval(code, filename, []);
      parseFile(undefined, filename, code);
      analyzeOxcBarrelFile(code, filename);
      emitOxcCommonJS(code, filename);
    });

    expect(parse).toMatchObject({
      allRequests: 6,
      cacheHits: 5,
      cacheMisses: 1,
      parserAttempts: 1,
      uncachedRequests: 0,
    });
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
