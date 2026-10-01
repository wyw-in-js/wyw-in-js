import { css } from '@wyw-in-js/template-tag-syntax';

const timers = [1, 2];
let cleanupCount = 0;
while (timers.length && ++cleanupCount) clearTimeout(timers.pop());

let conditional = 1;
if (false) clearTimeout(0);
else conditional = 2;

let iterations = 0;
while (iterations < 3) {
  clearTimeout(iterations);
  iterations++;
}

export const className = css`
  --cleanup-count: ${cleanupCount};
  --conditional: ${conditional};
  --iterations: ${iterations};
`;
