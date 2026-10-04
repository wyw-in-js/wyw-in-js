import { css } from '@wyw-in-js/template-tag-syntax';
import { buttonSize } from './button';
import { iconSize } from './icon';

export const footerSize: number = buttonSize - iconSize;
export const footer = css`
  margin: ${footerSize}px;
`;
