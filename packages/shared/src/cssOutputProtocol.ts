/**
 * Suffix of the CSS emitted next to a transformed module when the CSS has to
 * be consumed as a CSS module (Next.js webpack and Turbopack integrations).
 */
export const WYW_CSS_MODULE_EXTENSION = '.wyw-in-js.module.css';

/**
 * Query that marks a request for the CSS extracted from a module
 * (`./Button.tsx?__wyw_css`) in the Turbopack `cssOutputMode: 'query'` mode.
 */
export const WYW_CSS_OUTPUT_QUERY = '__wyw_css';
