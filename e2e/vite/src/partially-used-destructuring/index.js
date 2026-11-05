import { css } from '@wyw-in-js/template-tag-syntax';

const createCssVars = (keys) =>
  Object.fromEntries(keys.map((key) => [key, `var(--${key})`]));

function edgeFallback() {
  return '2px';
}

// The template reads gap and pad, but pad and edge are read at runtime too, so
// the declaration, createCssVars and the edgeFallback default have to stay.
const { gap, pad, edge = edgeFallback() } = createCssVars(['gap', 'pad']);

export const root = css`
  gap: ${gap};
  padding: ${pad};
  margin: ${edgeFallback()};
`;

export const clipPath = (n) => `calc(${n}px - ${pad} - ${edge})`;
