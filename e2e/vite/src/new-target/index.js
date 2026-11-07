import { css } from '@wyw-in-js/template-tag-syntax';

function Color(value) {
  this.value = new.target ? value : 'blue';
}

function Size(value) {
  if (!new.target) return new Size(value);
  this.value = value;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const error = new ValidationError('invalid');

// Each value depends on a statement that reads new.target.
export const root = css`
  color: ${new Color('red').value};
  width: ${Size('10px').value};
  --error: ${error instanceof ValidationError ? error.name : 'unknown'};
`;
