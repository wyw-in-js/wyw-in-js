import { memoizeBindingFact } from './bindingIdentity';
import type { Binding } from './types';

export const unknownAliasMutationBinding =
  '\0wyw-static-unknown-alias-mutation';

const toScopedMutationBindingKey = memoizeBindingFact(
  (binding: Binding): string =>
    `\0wyw-static-scope:${binding.scope.start}:${binding.declaredAt}:${binding.name}`,
  new WeakMap()
);

export const toMutationBindingKey = (binding: Binding): string =>
  binding.isRoot ? binding.name : toScopedMutationBindingKey(binding);
