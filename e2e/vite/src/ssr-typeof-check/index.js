import { css } from '@wyw-in-js/template-tag-syntax';

// Plain JavaScript on purpose: Vite runs esbuild on TypeScript before wyw, and
// esbuild rewrites these checks to a bare `typeof window`. Prettier would do
// the same, hence the ignore comments.

// prettier-ignore
const windowEnv = typeof(window) !== 'undefined' ? 'browser' : 'server';

// prettier-ignore
const documentEnv = typeof ((document)) !== 'undefined' ? 'browser' : 'server';

export const env = css`
  --ssr-window: ${windowEnv};
  --ssr-document: ${documentEnv};
`;
