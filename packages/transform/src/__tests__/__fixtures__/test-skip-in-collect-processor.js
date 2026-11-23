const { BaseProcessor } = require('@wyw-in-js/processor-utils');

const { default: CssProcessor } = require('./test-css-processor');

// Builds in the preeval stage and steps aside in the collect stage. The root
// then reaches collect with no processor left, which is the late branch of the
// workflow that returns changed code without CSS metadata. The collect stage
// is told apart by the perf prefix it passes in the processor options.
class SkipInCollectProcessor extends CssProcessor {
  constructor(...args) {
    const options = args[8];
    if (String(options?.perfPrefix ?? '').includes(':collect')) {
      throw BaseProcessor.SKIP;
    }

    super(...args);
  }
}

module.exports = { default: SkipInCollectProcessor };
