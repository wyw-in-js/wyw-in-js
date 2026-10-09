import type { ObservedStep, StepExpectation, StepObservation } from './types';

/**
 * - `current`  — today's behaviour, including the steps marked `knownBug`;
 * - `intended` — the behaviour the steps should have; a fixed or a new
 *   engine is expected to pass the table in this mode.
 */
export type ExpectationMode = 'current' | 'intended';

export const getExpectation = (
  step: ObservedStep,
  mode: ExpectationMode
): StepExpectation => {
  const expectation =
    mode === 'intended' && step.knownBug
      ? { ...step.expect, ...step.knownBug.intended }
      : step.expect;

  return { reset: 'none', ...expectation };
};

/**
 * Projects an observation onto the keys an expectation specifies, so a
 * scenario only pins what it states. Errors are matched by substring.
 */
export const toComparable = (
  observation: StepObservation,
  expectation: StepExpectation
): StepExpectation => {
  const comparable: StepExpectation = {};
  if (expectation.css) comparable.css = observation.css;
  if (expectation.error) {
    comparable.error = Object.fromEntries(
      Object.entries(observation.error).map(([label, message]) => {
        const expected = expectation.error?.[label];
        return [
          label,
          expected !== undefined && message.includes(expected)
            ? expected
            : message,
        ];
      })
    );
  }
  if (expectation.prepared) comparable.prepared = observation.prepared;
  if (expectation.evaluated) comparable.evaluated = observation.evaluated;
  if (expectation.reset) comparable.reset = observation.reset;
  if (expectation.consumed !== undefined) {
    comparable.consumed = observation.consumed;
  }

  return comparable;
};
