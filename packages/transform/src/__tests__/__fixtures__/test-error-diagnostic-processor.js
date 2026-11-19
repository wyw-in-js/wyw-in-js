const { TaggedTemplateProcessor } = require('@wyw-in-js/processor-utils');

class ErrorDiagnosticProcessor extends TaggedTemplateProcessor {
  get asSelector() {
    return this.className;
  }

  get value() {
    return this.astService.stringLiteral(this.className);
  }

  build(valueCache) {
    super.build(valueCache);
    this.addDiagnostic({
      category: 'test/blocking-rule',
      message: 'This rule blocks the build.',
      severity: 'error',
    });
  }

  addInterpolation(_node, _precedingCss, source) {
    throw new Error(
      `css tag cannot handle '${source}' as an interpolated value`
    );
  }

  doEvaltimeReplacement() {
    this.replacer(this.value, false);
  }

  doRuntimeReplacement() {
    this.replacer(this.value, false);
  }

  extractRules(_valueCache, cssText, loc) {
    const selector = `.${this.className}`;

    return {
      [selector]: {
        cssText,
        className: this.className,
        displayName: this.displayName,
        start: loc?.start ?? null,
      },
    };
  }
}

module.exports = { default: ErrorDiagnosticProcessor };
