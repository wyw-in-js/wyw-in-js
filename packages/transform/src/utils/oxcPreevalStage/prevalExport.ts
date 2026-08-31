import { parseOxcSync } from '../parseOxc';


import { recordPipelineUncachedParse } from '../../debug/pipelineTelemetry';

const parseSourceType = (
  code: string,
  filename: string
): 'module' | 'script' => {
  const astType =
    filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(filename, code, {
      astType,
      range: true,
      sourceType: 'unambiguous',
    });
  } catch (error) {
    recordPipelineUncachedParse(filename, code, 'unambiguous', astType, true);
    throw error;
  }
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    recordPipelineUncachedParse(filename, code, 'unambiguous', astType, true);
    throw new Error(fatalError.message);
  }
  recordPipelineUncachedParse(filename, code, 'unambiguous', astType, false);

  return parsed.program.sourceType === 'script' ? 'script' : 'module';
};

export const appendOxcWywPreval = (
  code: string,
  filename: string,
  dependencyNames: string[]
): string => {
  const uniqueNames = [...new Set(dependencyNames)];
  const properties = uniqueNames.map((name) => `${name}: ${name}`).join(', ');
  const object = uniqueNames.length > 0 ? `{ ${properties} }` : '{}';

  if (parseSourceType(code, filename) === 'script') {
    return `${code}\nexports.__wywPreval = ${object};`;
  }

  return `${code}\nexport const __wywPreval = ${object};`;
};