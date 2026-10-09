import { css } from '@wyw-in-js/template-tag-syntax';

// The class is never referenced, so WyW extracts no CSS from this module.
// The processor still replaces the tag and removes its import.
const unusedClass = css`
  color: black;
`;

const noCss = 'no-css';

export { noCss };
