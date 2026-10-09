/** Source builders shared by the scenario groups. */

export const styled = (imports: string[], declarations: string): string =>
  [
    "import { css } from 'test-css-processor';",
    ...imports,
    '',
    `export const style = css\`${declarations}\`;`,
    '',
  ].join('\n');

/** Not statically resolvable: the value needs the eval runner. */
export const runtimeValue = (name: string, value: string): string =>
  `export const ${name} = (() => '${value}')();\n`;

export const staticValue = (name: string, value: string): string =>
  `export const ${name} = '${value}';\n`;

/** `root.ts` reading `color` from `./dep`. */
export const rootWithDep = styled(
  ["import { color } from './dep';"],
  'color: ${color};'
);

/** Nothing was recomputed: the step was served from the cache. */
export const fromCache = { prepared: [], evaluated: [] };
