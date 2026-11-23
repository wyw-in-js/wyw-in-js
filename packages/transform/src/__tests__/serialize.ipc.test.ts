import {
  deserializeValue,
  serializePreval,
  serializeValue,
} from '@wyw-in-js/shared';

class ComponentStyle {
  public readonly current = 1;
}

describe('eval IPC serialization', () => {
  it('round-trips nested plain data without JSON coercion', () => {
    const boom = new TypeError('boom');
    boom.stack = 'TypeError: boom';

    const input = {
      nothing: null,
      enabled: true,
      label: 'demo',
      count: 42,
      nested: {
        missing: undefined,
        bigint: 17n,
        values: [undefined, Number.NaN, Infinity, -Infinity, { ok: 'yes' }],
        failure: boom,
      },
    };

    const roundTripped = deserializeValue(
      serializeValue(input, { allowFunctions: true })
    ) as {
      nothing: null;
      enabled: boolean;
      label: string;
      count: number;
      nested: {
        missing?: undefined;
        bigint: bigint;
        values: [undefined, number, number, number, { ok: string }];
        failure: Error;
      };
    };

    expect(roundTripped.nothing).toBeNull();
    expect(roundTripped.enabled).toBe(true);
    expect(roundTripped.label).toBe('demo');
    expect(roundTripped.count).toBe(42);
    expect(roundTripped.nested.bigint).toBe(17n);
    expect(roundTripped.nested.values[0]).toBeUndefined();
    expect(Number.isNaN(roundTripped.nested.values[1])).toBe(true);
    expect(roundTripped.nested.values[2]).toBe(Infinity);
    expect(roundTripped.nested.values[3]).toBe(-Infinity);
    expect(roundTripped.nested.values[4]).toEqual({ ok: 'yes' });
    expect(
      Object.prototype.hasOwnProperty.call(roundTripped.nested, 'missing')
    ).toBe(true);
    expect(roundTripped.nested.failure).toBeInstanceOf(Error);
    expect(roundTripped.nested.failure).toMatchObject({
      message: 'boom',
      name: 'TypeError',
      stack: 'TypeError: boom',
    });
  });

  it('preserves functions as opaque callable sentinels', () => {
    const input = {
      topLevel: () => 'value',
      nested: {
        list: [() => 1],
        marker: Symbol.for('react.forward_ref'),
      },
    };

    const roundTripped = deserializeValue(
      serializeValue(input, { allowFunctions: true, allowSymbols: true })
    ) as {
      topLevel: () => unknown;
      nested: {
        list: Array<() => unknown>;
        marker: symbol;
      };
    };

    expect(typeof roundTripped.topLevel).toBe('function');
    expect(roundTripped.topLevel()).toBeUndefined();
    expect(typeof roundTripped.nested.list[0]).toBe('function');
    expect(roundTripped.nested.list[0]()).toBeUndefined();
    expect(typeof roundTripped.nested.marker).toBe('symbol');
    expect(roundTripped.nested.marker).toBe(Symbol.for('react.forward_ref'));
  });

  it('defers unsupported nested properties until they are read', () => {
    const descriptor = {
      kind: 'foreign-descriptor',
      marker: Symbol.for('acme.handle'),
      metadata: {
        className: 'base',
      },
      runtimeState: new ComponentStyle(),
    };
    const serialized = serializePreval({ descriptor }).descriptor;
    const roundTripped = deserializeValue(serialized) as {
      kind: string;
      marker: symbol;
      metadata: { className: string };
      runtimeState: ComponentStyle;
    };

    expect(roundTripped.kind).toBe('foreign-descriptor');
    expect(roundTripped.marker).toBe(Symbol.for('acme.handle'));
    expect(roundTripped.metadata).toEqual({ className: 'base' });
    expect(Object.keys(roundTripped)).toEqual([
      'kind',
      'marker',
      'metadata',
      'runtimeState',
    ]);
    expect(() => roundTripped.runtimeState).toThrow(
      'unsupported non-plain object (ComponentStyle)'
    );
    expect(() => roundTripped.runtimeState).toThrow(
      '__wywPreval.descriptor.runtimeState'
    );

    roundTripped.runtimeState = {
      normalized: true,
    } as unknown as ComponentStyle;
    expect(roundTripped.runtimeState).toEqual({ normalized: true });

    expect(() =>
      serializeValue(descriptor, {
        allowFunctions: true,
        allowSymbols: true,
      })
    ).toThrow('unsupported non-plain object (ComponentStyle)');
  });

  it('preserves the serializable surface of a foreign component descriptor', () => {
    const descriptor = {
      $$typeof: Symbol.for('react.forward_ref'),
      attrs: [],
      componentStyle: new ComponentStyle(),
      foldedComponentIds: '',
      render: () => null,
      shouldForwardProp: () => true,
      styledComponentId: 'sc-example',
      target: 'div',
      warnTooManyClasses: () => undefined,
    };
    const roundTripped = deserializeValue(
      serializePreval({ descriptor }).descriptor
    ) as typeof descriptor;

    expect(roundTripped.$$typeof).toBe(Symbol.for('react.forward_ref'));
    expect(roundTripped.attrs).toEqual([]);
    expect(roundTripped.foldedComponentIds).toBe('');
    expect(roundTripped.styledComponentId).toBe('sc-example');
    expect(roundTripped.target).toBe('div');
    expect(typeof roundTripped.render).toBe('function');
    expect(typeof roundTripped.shouldForwardProp).toBe('function');
    expect(typeof roundTripped.warnTooManyClasses).toBe('function');
    expect(() => roundTripped.componentStyle).toThrow(
      '__wywPreval.descriptor.componentStyle'
    );
    expect(() => roundTripped.componentStyle).toThrow(
      'unsupported non-plain object (ComponentStyle)'
    );
  });

  it('defers circular branches without losing their serializable siblings', () => {
    const descriptor: { label: string; runtime?: unknown } = {
      label: 'safe',
    };
    descriptor.runtime = descriptor;

    const roundTripped = deserializeValue(
      serializePreval({ descriptor }).descriptor
    ) as typeof descriptor;

    expect(roundTripped.label).toBe('safe');
    expect(() => roundTripped.runtime).toThrow(
      'contains a circular reference at __wywPreval.descriptor.runtime'
    );
  });

  it('defers a nested getter failure but not an unexpected traversal failure', () => {
    const getterFailure = deserializeValue(
      serializePreval({
        value: {
          get unused() {
            throw new Error('unused getter failed');
          },
          usable: true,
        },
      }).value
    ) as { unused: unknown; usable: boolean };

    expect(getterFailure.usable).toBe(true);
    expect(() => getterFailure.unused).toThrow('unused getter failed');

    const traversalFailure = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy traversal failed');
        },
      }
    );
    expect(() =>
      serializePreval({ value: { nested: traversalFailure } })
    ).toThrow('proxy traversal failed');
  });

  it('drops symbol-keyed properties only when serializing __wywPreval values', () => {
    const marker = Symbol('runtimeMetadata');
    const input = {
      label: 'button',
      [marker]: 'metadata',
    };

    const roundTripped = deserializeValue(serializePreval({ input }).input) as {
      label: string;
    };

    expect(roundTripped).toEqual({ label: 'button' });
    expect(Object.getOwnPropertySymbols(roundTripped)).toHaveLength(0);
    expect(() =>
      serializeValue(input, {
        allowSymbols: true,
        rootLabel: 'value',
      })
    ).toThrow('unsupported symbol-keyed property');
  });

  it('unwraps boxed primitives to their primitive payloads', () => {
    const roundTripped = deserializeValue(
      serializeValue({
        bool: Object(false),
        count: Object(0.75),
        label: Object('100%'),
      })
    ) as {
      bool: boolean;
      count: number;
      label: string;
    };

    expect(roundTripped).toEqual({
      bool: false,
      count: 0.75,
      label: '100%',
    });
  });

  it('defers unsupported values nested inside serializable containers', () => {
    const roundTripped = deserializeValue(
      serializePreval({ value: { nested: [new Date(0)], usable: true } }).value
    ) as { nested: Date[]; usable: boolean };

    expect(roundTripped.usable).toBe(true);
    expect(() => roundTripped.nested[0]).toThrow('__wywPreval.value.nested[0]');
    expect(() => roundTripped.nested[0]).toThrow(
      'unsupported non-plain object (Date)'
    );
  });

  it.each([
    {
      label: 'Date',
      value: { value: new Date(0) },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (Date)',
    },
    {
      label: 'Map',
      value: { value: new Map([['a', 1]]) },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (Map)',
    },
    {
      label: 'Set',
      value: { value: new Set([1]) },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (Set)',
    },
    {
      label: 'class instance',
      value: {
        value: new ComponentStyle(),
      },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (ComponentStyle)',
    },
  ])(
    'reports path-aware failures for $label values',
    ({ value, path, detail }) => {
      expect(() => serializePreval(value)).toThrow('[wyw-in-js] __wywPreval');
      expect(() => serializePreval(value)).toThrow(path);
      expect(() => serializePreval(value)).toThrow(detail);
    }
  );
});
