// A TypeScript config with a function option: every worker loads it.
const suffix: string = '-ts-config';

export default {
  classNameSlug: (hash: string): string => `${hash}${suffix}`,
};
