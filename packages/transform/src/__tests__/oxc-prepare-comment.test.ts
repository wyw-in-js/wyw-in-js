/* eslint-env jest */
import { join } from 'path';

import dedent from 'dedent';

import { oxcShaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { prepareCodeForEvalRuntime } from '../transform/generators/transform';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createServices = (filename: string, root: string) =>
  withDefaultServices({
    options: {
      filename,
      root,
      pluginOptions: loadWywOptions({
        configFile: false,
        eval: { strategy: 'hybrid' },
        rules: [{ action: oxcShaker, test: () => true }],
        tagResolver: (source, tag) =>
          source === 'test-css-processor' && tag === 'css'
            ? processorFile
            : null,
      }),
    },
  });

describe('comment.tsx-like prepare', () => {
  it('does not keep memo wrapper alive via aliased re-import of same name', () => {
    // Repro: a file declares a top-level `Comment` AND imports a same-named
    // identifier from another module under an alias (`Comment as Other`).
    // Before the imported-name reference fix, the shaker treated the imported
    // name `Comment` as a reference to the local `Comment` binding, marking
    // `var Comment = memo(...)` live and pulling `memo` along with it.
    const root = __dirname;
    const filename = join(root, 'comment-like.tsx');
    const source = dedent`
      import { Comment as CommentComponent, commentContentStyle } from './ui-kit/comment';
      import { themeVars } from './design-system';
      import { memo } from 'react';

      var _exp = () => themeVars.color;
      var _exp2 = () => commentContentStyle;

      export const Comment = memo(function Comment(props) {
        return null;
      });

      export const __wywPreval = { _exp, _exp2 };
    `;

    const services = createServices(filename, root);
    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['__wywPreval'],
      source
    );

    if (entrypoint.ignored) {
      throw new Error('ignored');
    }

    const [code, imports] = prepareCodeForEvalRuntime(services, entrypoint);

    expect(code).not.toContain('var Comment');
    expect(code).not.toContain("from 'react'");
    expect(code).not.toContain('memo(');
    expect(imports?.has('react')).toBe(false);
    // CommentComponent is unused → its import should also be pruned.
    expect(imports?.get('./ui-kit/comment')).toEqual(['commentContentStyle']);
  });
});
