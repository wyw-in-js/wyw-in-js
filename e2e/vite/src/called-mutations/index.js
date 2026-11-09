import { css } from '@wyw-in-js/template-tag-syntax';

import { padding, width, zIndex } from './values';

// The values are changed by functions that run when the modules load, so the
// build has to evaluate them instead of reading their initial values.
let gap = 1;
const grow = () => {
  gap += 2;
};
grow();

export const root = css`
  padding: ${padding};
  z-index: ${zIndex};
  width: ${width};
  gap: ${gap}px;
`;
