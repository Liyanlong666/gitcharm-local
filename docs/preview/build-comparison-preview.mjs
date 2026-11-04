import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Render the production comparison editor template with a local mock host. */
const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const i18n = require(path.join(root, 'out/i18n/index.js'));
i18n.setLocale('zh-cn');
const source = readFileSync(path.join(root, 'src/views/comparisonEditor.ts'), 'utf8');
const start = source.indexOf('return `<!DOCTYPE html>') + 'return '.length;
const end = source.indexOf('</html>`;', start) + '</html>`'.length;
if (start < 7 || end < start) throw new Error('comparison template missing');
const render = new Function('getLocale', 'nonce', 'css', 'js', 'strings', 'webview', 't', 'return ' + source.slice(start, end));
let html = render(i18n.getLocale, 'preview', '../../media/comparisonEditor.css', '../../media/comparisonEditor.js',
    JSON.stringify(i18n.webviewStrings()).replace(/</g, '\\u003c'), { cspSource: "'self'" }, i18n.t);
html = html.replace('</head>', '<link rel="stylesheet" href="./theme-dark.css"></head>')
    .replace('<script nonce="preview" src="../../media/comparisonEditor.js">', '<script nonce="preview" src="./comparison-harness.js"></script><script nonce="preview" src="../../media/comparisonEditor.js">');
writeFileSync(path.join(root, 'docs/preview/comparison-preview.html'), html);
console.log('wrote comparison-preview.html');
