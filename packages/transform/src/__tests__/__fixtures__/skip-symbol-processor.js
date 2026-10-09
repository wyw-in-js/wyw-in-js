// Models a processor built against another copy of @wyw-in-js/processor-utils:
// that copy's BaseProcessor owns its own Symbol('skip').
class OtherCopyBaseProcessor {
  static SKIP = Symbol('skip');

  isValidValue() {
    return true;
  }
}

class SkipSymbolProcessor extends OtherCopyBaseProcessor {
  constructor() {
    throw OtherCopyBaseProcessor.SKIP;
  }
}

module.exports = { default: SkipSymbolProcessor };
