import { css } from '@wyw-in-js/template-tag-syntax';
import { spacingSize } from './spacing';

export const buttonSize: number = spacingSize * 2;
export const button = css`
  margin: ${buttonSize}px;
`;
