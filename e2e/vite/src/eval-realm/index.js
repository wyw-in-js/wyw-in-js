import { css } from '@wyw-in-js/template-tag-syntax';

const engineError = (() => {
  try {
    return null.x;
  } catch (e) {
    return e;
  }
})();

// Evaluated with the default DOM emulation: object and array literals, engine
// errors and the global constructors have to come from the same realm.
const realm = [
  {}.constructor === Object,
  [] instanceof Array,
  Object.getPrototypeOf([]) === Array.prototype,
  engineError instanceof TypeError,
].join(' ');

export const probe = css`
  --realm: ${realm};
`;
