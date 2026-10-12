import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type ReportedWarning = { code?: string; message: string; name: string };

type ChildReport = {
  afterPlainTransforms: ReportedWarning[];
  conflictUsesConfigRules: boolean;
  conflictingRules: string[][];
  cssOptions: string[][];
  customHandlerWarnings: ReportedWarning[];
  customResolverMissing: string[][];
  customResolverSet: string[];
  emptyHandlersOutputSame: boolean;
  handlersOutputSame: boolean;
  noCssOptions: string[];
  pluginRulesOnly: string[];
  reloadedRulesAreCopies: boolean;
  sameRules: string[];
  unexpected: string[];
};

const childScript = path.join(
  __dirname,
  '__fixtures__',
  'once-warnings-child.ts'
);

// The warnings are reported once per process, and the test runner shares one
// process between test files, so the scenarios run in a fresh child process.
let report: ChildReport;

beforeAll(async () => {
  const { stdout } = await execFileAsync(process.execPath, [childScript], {
    cwd: path.resolve(__dirname, '..', '..'),
  });
  const lines = stdout.trim().split('\n');
  report = JSON.parse(lines[lines.length - 1]) as ChildReport;
}, 60_000);

describe('one-time warnings', () => {
  it('warns once about eval.resolver "custom" without a custom resolver', () => {
    expect(report.customResolverMissing[0]).toHaveLength(1);
    expect(report.customResolverMissing[0][0]).toContain(
      '`eval.customResolver` is not set'
    );
    expect(report.customResolverMissing[0][0]).toContain('3.0');
    expect(report.customResolverMissing[1]).toEqual([]);
    expect(report.customResolverSet).toEqual([]);
  });

  it('warns once when rules of the config file and the plugin differ, and keeps the config file rules', () => {
    expect(report.reloadedRulesAreCopies).toBe(true);
    expect(report.sameRules).toEqual([]);
    expect(report.pluginRulesOnly).toEqual([]);
    expect(report.conflictingRules[0]).toHaveLength(1);
    expect(report.conflictingRules[0][0]).toContain(
      'Both the config file and the plugin options set `rules`'
    );
    expect(report.conflictingRules[1]).toEqual([]);
    expect(report.conflictUsesConfigRules).toBe(true);
  });

  it('warns once about CSS options in the config file', () => {
    expect(report.cssOptions[0]).toHaveLength(1);
    expect(report.cssOptions[0][0]).toContain(
      'The config file sets `prefixer` and `keepComments`'
    );
    expect(report.cssOptions[1]).toEqual([]);
    expect(report.noCssOptions).toEqual([]);
  });

  it('emits one DeprecationWarning for customHandlers and keeps the output', () => {
    expect(report.afterPlainTransforms).toEqual([]);
    expect(report.customHandlerWarnings).toHaveLength(1);
    expect(report.customHandlerWarnings[0]).toMatchObject({
      code: 'WYW_CUSTOM_HANDLERS_DEPRECATED',
      name: 'DeprecationWarning',
    });
    expect(report.customHandlerWarnings[0].message).toContain('3.0');
    expect(report.emptyHandlersOutputSame).toBe(true);
    expect(report.handlersOutputSame).toBe(true);
  });

  it('reports nothing else', () => {
    expect(report.unexpected).toEqual([]);
  });
});
