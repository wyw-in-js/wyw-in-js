import type { Node } from 'oxc-parser';
import { matchesOxcRuntimePropertyPath } from '../oxc/projections';
import { getStaticMemberPath } from './bindingProvenance';
import type { AliasEnvironment } from './callableProvenanceIndex';
import { isMemberRead, unwrapAliasExpression } from './executableIndex';
import type { ReceiverOperation } from './patternEffects';

export const createReceiverOperationCollector = (
  addReceiverOperationEffects: (
    operation: ReceiverOperation,
    aliases: AliasEnvironment
  ) => void
) => {
  return (
    current: Node,
    parent: Node | null,
    aliases: AliasEnvironment
  ): void => {
    const addMemberOperation = (
      member: Extract<Node, { type: 'MemberExpression' }>,
      kind: ReceiverOperation['kind']
    ): void => {
      addReceiverOperationEffects(
        {
          kind,
          property: {
            computed: member.computed,
            key: member.property,
          },
          receiver: member.object,
        },
        aliases
      );
    };

    const addPatternOperations = (pattern: Node, value: Node): void => {
      const currentPattern = unwrapAliasExpression(pattern);
      if (currentPattern.type === 'ArrayPattern') {
        addReceiverOperationEffects(
          { kind: 'iterate', receiver: value },
          aliases
        );
        return;
      }
      if (currentPattern.type !== 'ObjectPattern') {
        return;
      }

      currentPattern.properties.forEach((property) => {
        if (property.type === 'RestElement') {
          addReceiverOperationEffects(
            { kind: 'copy', receiver: value },
            aliases
          );
          return;
        }
        addReceiverOperationEffects(
          {
            kind: 'get',
            property: {
              computed: property.computed,
              key: property.key,
            },
            receiver: value,
          },
          aliases
        );
      });
    };

    if (current.type === 'VariableDeclaration') {
      current.declarations.forEach((declarator) => {
        if (declarator.init) {
          addPatternOperations(declarator.id, declarator.init);
        }
      });
      return;
    }

    if (current.type === 'MemberExpression' && isMemberRead(current, parent)) {
      addMemberOperation(current, 'get');
      return;
    }

    if (
      current.type === 'AssignmentExpression' &&
      current.left.type === 'MemberExpression'
    ) {
      addMemberOperation(current.left, 'set');
      return;
    }
    if (current.type === 'AssignmentExpression' && current.operator === '=') {
      addPatternOperations(current.left, current.right);
    }

    if (
      current.type === 'UpdateExpression' &&
      current.argument.type === 'MemberExpression'
    ) {
      addMemberOperation(current.argument, 'set');
      return;
    }

    if (
      current.type === 'UnaryExpression' &&
      current.operator === 'delete' &&
      current.argument.type === 'MemberExpression'
    ) {
      addMemberOperation(current.argument, 'delete');
      return;
    }

    if (current.type === 'BinaryExpression' && current.operator === 'in') {
      addReceiverOperationEffects(
        {
          kind: 'has',
          property: {
            computed: true,
            key: current.left,
          },
          receiver: current.right,
        },
        aliases
      );
      return;
    }

    if (current.type === 'ForInStatement') {
      addReceiverOperationEffects(
        { kind: 'ownKeys', receiver: current.right },
        aliases
      );
      return;
    }

    if (current.type === 'ForOfStatement') {
      addReceiverOperationEffects(
        { kind: 'iterate', receiver: current.right },
        aliases
      );
      return;
    }

    if (
      current.type === 'YieldExpression' &&
      current.delegate &&
      current.argument
    ) {
      addReceiverOperationEffects(
        { kind: 'iterate', receiver: current.argument },
        aliases
      );
      return;
    }

    if (current.type === 'SpreadElement') {
      if (parent?.type === 'ArrayExpression') {
        addReceiverOperationEffects(
          { kind: 'iterate', receiver: current.argument },
          aliases
        );
      } else if (parent?.type === 'ObjectExpression') {
        addReceiverOperationEffects(
          { kind: 'copy', receiver: current.argument },
          aliases
        );
      }
      return;
    }

    if (current.type !== 'CallExpression') {
      return;
    }

    const intrinsic = getStaticMemberPath(current.callee);
    const firstArgument = current.arguments[0];
    if (!firstArgument || firstArgument.type === 'SpreadElement') {
      return;
    }

    if (
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'keys') ||
      matchesOxcRuntimePropertyPath(
        intrinsic,
        'Object',
        'getOwnPropertyNames'
      ) ||
      matchesOxcRuntimePropertyPath(
        intrinsic,
        'Object',
        'getOwnPropertySymbols'
      ) ||
      matchesOxcRuntimePropertyPath(
        intrinsic,
        'Object',
        'getOwnPropertyDescriptors'
      ) ||
      matchesOxcRuntimePropertyPath(intrinsic, 'Reflect', 'ownKeys')
    ) {
      addReceiverOperationEffects(
        { kind: 'ownKeys', receiver: firstArgument },
        aliases
      );
    } else if (
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'values') ||
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'entries')
    ) {
      addReceiverOperationEffects(
        { kind: 'copy', receiver: firstArgument },
        aliases
      );
    } else if (
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'fromEntries') ||
      matchesOxcRuntimePropertyPath(intrinsic, 'Array', 'from')
    ) {
      addReceiverOperationEffects(
        { kind: 'iterate', receiver: firstArgument },
        aliases
      );
    } else if (matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'assign')) {
      current.arguments.slice(1).forEach((argument) => {
        if (argument.type !== 'SpreadElement') {
          addReceiverOperationEffects(
            { kind: 'copy', receiver: argument },
            aliases
          );
        }
      });
    }
  };
};
