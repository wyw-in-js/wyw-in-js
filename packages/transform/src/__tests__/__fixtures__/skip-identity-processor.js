const { BaseProcessor } = require('@wyw-in-js/processor-utils');

class SkipIdentityProcessor extends BaseProcessor {
  constructor() {
    throw BaseProcessor.SKIP;
  }
}

module.exports = { default: SkipIdentityProcessor };
