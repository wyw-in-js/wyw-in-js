/* eslint-disable no-await-in-loop, no-console, no-continue */
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { Artifact, Rules } from '@wyw-in-js/shared';

import type * as ExtractModule from '../src/transform/generators/extract';

// Measures the extract stage in isolation:
// - `merge`: many processors with one CSS rule each and the `none`
//   preprocessor, so the time is dominated by merging the rules;
// - `stylis`: many rules of one file through the default Stylis preprocessor;
// - `stylis-output`: the same with `outputFilename`, as the CLI runs it.
//
// `--root` points at another checkout of `packages/transform`, which lets the
// same script measure a baseline worktree. The `css` column is a hash of the
// generated CSS and source map: it must match between the two runs.

type CliOptions = {
  iterations: number;
  json: boolean;
  root: string;
  warmup: number;
};

type Scenario = 'merge' | 'stylis' | 'stylis-output';

type BenchmarkCase = {
  id: string;
  rules: number;
  scenario: Scenario;
};

type BenchmarkResult = BenchmarkCase & {
  cssBytes: number;
  cssSha256: string;
  maxMs: number;
  medianMs: number;
  minMs: number;
  samplesMs: number[];
};

type Processor = { artifacts: Artifact[] };

const RULE_COUNTS: Record<Scenario, number[]> = {
  merge: [500, 2000, 8000],
  stylis: [250, 1000, 4000],
  'stylis-output': [250, 1000, 4000],
};

const FILENAME = '/perf/src/components/Component.tsx';
const OUTPUT_FILENAME = '/perf/dist/styles/Component.css';

// A mix of the shapes the Stylis plugins handle: plain declarations, nesting,
// vendor prefixes, multi-keyword display, url(), :global(), scoped keyframes.
const RULE_TEMPLATES = [
  (i: number) => `color: #${(i % 4096).toString(16).padStart(3, '0')};
  padding: ${i % 16}px ${i % 8}px;
  &:hover { color: red; }
  & > span { margin-left: ${i % 10}px; }`,
  (i: number) => `display: inline flex;
  align-items: center;
  justify-content: space-between;
  transition: opacity ${i % 500}ms ease-in;
  user-select: none;`,
  (i: number) => `background: url(./images/icon-${i}.svg) no-repeat;
  mask: url("../masks/mask-${i % 7}.svg");
  &::placeholder { color: gray; }`,
  (
    i: number
  ) => `@keyframes spin { from { transform: rotate(0) } to { transform: rotate(${
    i % 360
  }deg) } }
  animation: spin 1s linear infinite;
  @media (min-width: ${320 + (i % 10) * 64}px) { animation-name: spin; }`,
  (i: number) => `& :global(.theme-${i % 5}) { color: white; }
  :global() { body { margin: 0; } }
  animation::global(fade-${i % 3}) 0s forwards;`,
];

const range = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index);

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

const buildProcessors = (count: number, scenario: Scenario): Processor[] =>
  range(count).map((index) => {
    const selector = `.c${index.toString(36)}`;
    const rules: Rules = {
      [selector]: {
        className: selector.slice(1),
        cssText:
          scenario === 'merge'
            ? `color: red; z-index: ${index};`
            : RULE_TEMPLATES[index % RULE_TEMPLATES.length]!(index),
        displayName: `Component${index}`,
        start: { line: index + 1, column: 0 },
      },
    };

    return { artifacts: [['css', [rules, []]]] };
  });

const loadExtract = async (root: string): Promise<typeof ExtractModule> => {
  const file = path.join(root, 'src/transform/generators/extract.ts');
  return import(pathToFileURL(file).href);
};

const runExtract = (
  extract: typeof ExtractModule.extract,
  processors: Processor[],
  scenario: Scenario
) => {
  const options = {
    filename: FILENAME,
    outputFilename: scenario === 'stylis-output' ? OUTPUT_FILENAME : undefined,
    preprocessor: scenario === 'merge' ? 'none' : 'stylis',
  };
  const action = {
    data: { processors },
    entrypoint: {
      loadedAndParsed: { code: '', evaluator: () => {} },
    },
    services: { options },
  };

  const step = extract.call(action as never).next();
  if (!step.done) {
    throw new Error('extract yielded instead of returning a result');
  }

  return step.value;
};

const parseArgs = (): CliOptions => {
  const options: CliOptions = {
    iterations: 7,
    json: false,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    warmup: 2,
  };
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--iterations') {
      options.iterations = Number(args[(index += 1)]);
      continue;
    }
    if (arg === '--warmup') {
      options.warmup = Number(args[(index += 1)]);
      continue;
    }
    if (arg === '--root') {
      options.root = path.resolve(args[(index += 1)]!);
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run ./scripts/perf-extract-stylis.ts [options]

Options:
  --root <dir>      packages/transform checkout to measure (default: this one)
  --iterations <n>  measured runs per benchmark cell (default: 7)
  --warmup <n>      warmup runs per benchmark cell (default: 2)
  --json            print the complete samples as JSON
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error('--iterations must be a positive integer');
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error('--warmup must be a non-negative integer');
  }

  return options;
};

const runCell = (
  extract: typeof ExtractModule.extract,
  benchmarkCase: BenchmarkCase,
  options: CliOptions
): BenchmarkResult => {
  const processors = buildProcessors(
    benchmarkCase.rules,
    benchmarkCase.scenario
  );
  let signature: string | undefined;
  let cssBytes = 0;

  const runOnce = (): number => {
    const startedAt = performance.now();
    const result = runExtract(extract, processors, benchmarkCase.scenario);
    const elapsed = performance.now() - startedAt;

    const current = hash(`${result.cssText}\0${result.cssSourceMapText}`);
    if (signature !== undefined && signature !== current) {
      throw new Error(`${benchmarkCase.id}: output changed between runs`);
    }
    signature = current;
    cssBytes = result.cssText.length;

    return elapsed;
  };

  range(options.warmup).forEach(runOnce);
  const samplesMs = range(options.iterations).map(runOnce);

  return {
    ...benchmarkCase,
    cssBytes,
    cssSha256: signature!,
    maxMs: round(Math.max(...samplesMs)),
    medianMs: round(median(samplesMs)),
    minMs: round(Math.min(...samplesMs)),
    samplesMs: samplesMs.map(round),
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const { extract } = await loadExtract(options.root);
  const cases: BenchmarkCase[] = (
    Object.keys(RULE_COUNTS) as Scenario[]
  ).flatMap((scenario) =>
    RULE_COUNTS[scenario].map((rules) => ({
      id: `${scenario}-${rules}`,
      rules,
      scenario,
    }))
  );

  console.log(`root: ${options.root}`);
  console.log(
    ['case'.padEnd(20), 'median ms'.padStart(10), 'min'.padStart(9)]
      .concat(['max'.padStart(9), 'css bytes'.padStart(10), 'css'.padStart(14)])
      .join(' ')
  );

  const results: BenchmarkResult[] = [];
  for (const benchmarkCase of cases) {
    const result = runCell(extract, benchmarkCase, options);
    results.push(result);
    console.log(
      [
        result.id.padEnd(20),
        result.medianMs.toFixed(3).padStart(10),
        result.minMs.toFixed(3).padStart(9),
        result.maxMs.toFixed(3).padStart(9),
        String(result.cssBytes).padStart(10),
        result.cssSha256.slice(0, 12).padStart(14),
      ].join(' ')
    );
  }

  if (options.json) {
    console.log(JSON.stringify({ options, results }, null, 2));
  }
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
