import { parseOxcCached } from '../parseOxc';

// The source type comes from the shared parse of this exact code: later
// stages that read the same preeval code reuse it instead of parsing again.
const isScript = (code: string, filename: string): boolean =>
  parseOxcCached(filename, code, 'unambiguous').program.sourceType === 'script';

export const appendOxcWywPreval = (
  code: string,
  filename: string,
  dependencyNames: string[]
): string => {
  const uniqueNames = [...new Set(dependencyNames)];
  const properties = uniqueNames.map((name) => `${name}: ${name}`).join(', ');
  const object = uniqueNames.length > 0 ? `{ ${properties} }` : '{}';

  if (isScript(code, filename)) {
    return `${code}\nexports.__wywPreval = ${object};`;
  }

  return `${code}\nexport const __wywPreval = ${object};`;
};
