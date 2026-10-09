import { css } from '@wyw-in-js/template-tag-syntax';
import { classB } from './alias';
import { noCss } from './no-css';

const classA = css`
  /*rtl:ignore*/
  color: red;
  background: green;
`;

export { classA, classB, noCss };
