import { css } from '@wyw-in-js/template-tag-syntax';

import { spacing } from './tokens';

export const className = css`
  padding: ${spacing}px;

  &::before {
    content: 'Привет 👋';
  }
`;

export const View = () => <div className={className} />;
