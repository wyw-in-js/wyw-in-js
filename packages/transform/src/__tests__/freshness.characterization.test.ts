/**
 * Freshness characterization: table-driven invalidation scenarios executed
 * through `transform()` and a shared `TransformCacheCollection`.
 *
 * The table (`__utils__/freshness/scenarios`) pins the current behaviour.
 * Steps whose behaviour is wrong today carry `knownBug` with the intended
 * observation; the same table can run in `intended` mode against a fixed or a
 * new engine (module graph, native) through another adapter.
 */
import {
  getExpectation,
  type ExpectationMode,
} from './__utils__/freshness/expectation';
import { toComparable } from './__utils__/freshness/expectation';
import { freshnessScenarios } from './__utils__/freshness/scenarios';
import { runWithTransform } from './__utils__/freshness/transformAdapter';
import {
  isObservingStep,
  type ObservedStep,
} from './__utils__/freshness/types';

// `WYW_FRESHNESS_EXPECTATIONS=intended` checks the intended behaviour instead:
// it fails exactly on the steps marked `knownBug` until they are fixed.
const MODE: ExpectationMode =
  process.env.WYW_FRESHNESS_EXPECTATIONS === 'intended'
    ? 'intended'
    : 'current';

const HISTORICAL_FIXES = [
  '#135',
  '#148',
  '#234',
  '#238',
  '#263',
  '#268',
  '#271',
  '#278',
  '#279',
  '#283',
  '#423',
  '#427',
];

const observingSteps = (steps: (typeof freshnessScenarios)[number]['steps']) =>
  steps.filter(isObservingStep);

const callLabels = (step: ObservedStep, started: string[]): string[] => {
  if (step.do === 'transform') {
    return step.calls.map((call) => call.id ?? call.file);
  }
  return step.do === 'join' ? started.splice(0) : [];
};

describe('freshness scenario table', () => {
  it('covers every historical invalidation fix', () => {
    const covered = new Set(
      freshnessScenarios.flatMap((scenario) => scenario.refs)
    );
    expect(HISTORICAL_FIXES.filter((ref) => !covered.has(ref))).toEqual([]);
  });

  it('has unique scenario ids and at least 15 scenarios', () => {
    const ids = freshnessScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(15);
  });

  it('pins output and recomputation for every call of every step', () => {
    const incomplete: string[] = [];
    freshnessScenarios.forEach((scenario) => {
      const started: string[] = [];
      scenario.steps.forEach((step, index) => {
        if (step.do === 'start') started.push(step.id);
        if (!isObservingStep(step)) return;

        const where = `${scenario.id}#${index}`;
        if (step.do === 'consumeInvalidation') {
          if (step.expect.consumed === undefined) incomplete.push(where);
          return;
        }

        const labels = callLabels(step, started);
        const pinned = labels.every(
          (label) =>
            step.expect.css?.[label] !== undefined ||
            step.expect.error?.[label] !== undefined
        );
        if (!pinned || !step.expect.prepared || !step.expect.evaluated) {
          incomplete.push(where);
        }
      });
    });

    expect(incomplete).toEqual([]);
  });
});

describe('freshness characterization', () => {
  freshnessScenarios.forEach((scenario) => {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const observations = await runWithTransform(scenario);
      const steps = observingSteps(scenario.steps);
      expect(observations).toHaveLength(steps.length);

      steps.forEach((step, index) => {
        const expectation = getExpectation(step, MODE);
        const actual = toComparable(observations[index], expectation);
        // The step number and note make a failing diff point at the table row.
        expect({ step: index, note: step.note, ...actual }).toEqual({
          step: index,
          note: step.note,
          ...expectation,
        });
      });
    }, 60_000);
  });
});
