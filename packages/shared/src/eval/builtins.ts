import { builtinModules } from 'module';

/**
 * Tells whether a specifier names a Node builtin module, with or without the
 * `node:` prefix.
 *
 * @internal Shared by the eval broker and the eval runner.
 */
export const isBuiltinSpecifier = (specifier: string): boolean => {
  const normalized = specifier.startsWith('node:')
    ? specifier.slice(5)
    : specifier;
  return (
    builtinModules.includes(normalized) ||
    builtinModules.includes(`node:${normalized}`)
  );
};
