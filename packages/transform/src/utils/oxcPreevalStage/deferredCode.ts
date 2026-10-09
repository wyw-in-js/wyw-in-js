export const deferOxcPreevalCode = (
  target: object,
  property: 'code' | 'evalCode',
  serialize: () => string
): void => {
  let code: string | undefined;
  let serializeCode: (() => string) | undefined = serialize;

  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: true,
    get: () => {
      if (code === undefined) {
        code = serializeCode!();
        serializeCode = undefined;
      }

      return code;
    },
    set: (value: string) => {
      code = value;
      serializeCode = undefined;
    },
  });
};
