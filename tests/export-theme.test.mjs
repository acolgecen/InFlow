import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appScript = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

const themeBlock = appScript.slice(
  appScript.indexOf('var themeDefinitions ='),
  appScript.indexOf('for (const definition of Object.values(themeDefinitions))')
);

function getFunction(name, nextName) {
  const start = appScript.indexOf(`function ${name}`);
  const end = nextName ? appScript.indexOf(`function ${nextName}`, start) : appScript.length;
  assert.ok(start >= 0, `${name} should exist`);
  return appScript.slice(start, end);
}

function loadDirectionDetector() {
  const source = getFunction('detectFlowDirection', 'updateDirectionUi');
  return new Function(`${source}; return detectFlowDirection;`)();
}

test('split application assets are wired up and valid', () => {
  assert.doesNotThrow(() => new Function(appScript));
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.match(css, /:root\[data-color-mode="light"\]/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('all ten palettes have the requested light and dark classifications', () => {
  const lightThemes = ['default', 'neutral', 'ocean', 'rose', 'sage'];
  const darkThemes = ['dark', 'forest', 'midnight', 'slate', 'mocha'];

  for (const theme of lightThemes) {
    assert.match(themeBlock, new RegExp(`${theme}:\\s*\\{[\\s\\S]*?mode: 'light'`));
  }
  for (const theme of darkThemes) {
    assert.match(themeBlock, new RegExp(`${theme}:\\s*\\{[\\s\\S]*?mode: 'dark'`));
  }

  const forest = themeBlock.slice(themeBlock.indexOf('forest:'), themeBlock.indexOf('midnight:'));
  assert.match(forest, /mode: 'dark'/);
  assert.match(forest, /background: '#08140d'/);
});

test('saved palette and operating-system preference choose the initial mode safely', () => {
  assert.match(appScript, /const THEME_STORAGE_KEY = 'inflow\.theme'/);
  assert.match(getFunction('safeReadSavedTheme', 'saveThemePreference'), /themeDefinitions\[saved\] \? saved : null/);
  assert.match(getFunction('resolveInitialTheme', 'applyInterfaceTheme'), /prefers-color-scheme: dark/);
  assert.match(getFunction('resolveInitialTheme', 'applyInterfaceTheme'), /prefersDark \? 'dark' : 'default'/);
  assert.match(getFunction('applyInterfaceTheme', 'renderThemePicker'), /root\.dataset\.colorMode = definition\.mode/);
  assert.match(getFunction('applyInterfaceTheme', 'renderThemePicker'), /root\.dataset\.theme = themeKey/);
});

test('flowcharts share SVG text, compact layout and polished geometry', () => {
  assert.match(appScript, /htmlLabels: false/);
  assert.match(appScript, /curve: 'stepAfter'/);
  assert.match(appScript, /nodeSpacing: 32/);
  assert.match(appScript, /rankSpacing: 56/);
  assert.match(appScript, /fontSize: '16px'/);
  assert.match(appScript, /function buildPolishedDiagramCss/);
  assert.match(appScript, /border-radius: 999px/);
  assert.match(appScript, /function applyPolishedSvgGeometry/);
  assert.match(appScript, /M 1 1 L 9 5 L 1 9/);
});

test('direction detection handles declarations, comments, aliases and missing input', () => {
  const detectFlowDirection = loadDirectionDetector();
  assert.equal(detectFlowDirection('flowchart LR\nA-->B'), 'LR');
  assert.equal(detectFlowDirection('graph TB\nA-->B'), 'TD');
  assert.equal(detectFlowDirection('flowchart BT\nA-->B'), 'BT');
  assert.equal(detectFlowDirection('  %% comment\n\n  graph RL\nA-->B'), 'RL');
  assert.equal(detectFlowDirection('flowchart TD\nA-->B'), 'TD');
  assert.equal(detectFlowDirection('flowchart\nA-->B'), null);
  assert.equal(detectFlowDirection('A-->B'), null);
});

test('typing, formatting, templates and controls share direction synchronization', () => {
  assert.match(appScript, /editor\.addEventListener\('input',[\s\S]*?syncDirectionFromCode\(editor\.value\)/);
  assert.match(getFunction('formatCode', 'loadTemplate'), /syncDirectionFromCode\(editor\.value\)/);
  assert.match(getFunction('loadTemplate', 'detectFlowDirection'), /syncDirectionFromCode\(editor\.value\)/);
  assert.match(getFunction('setDirection', 'selectNode'), /replace\(declaration/);
  assert.match(html, /Top down<\/button>/);
  assert.match(html, /Left to right<\/button>/);
  assert.match(html, /Bottom up<\/button>/);
  assert.match(html, /Right to left<\/button>/);
});

test('custom CSS applies immediately while later palette and node edits retain precedence', () => {
  assert.match(appScript, /customCssEditor\.addEventListener\('input'/);
  assert.match(appScript, /themeColorsOverrideCustomCss = false/);

  const styleFunction = getFunction('applySvgStyleLayers', 'setTheme');
  const defaults = styleFunction.indexOf("appendSvgStyle(svgEl, 'polished'");
  const authored = styleFunction.indexOf("appendSvgStyle(svgEl, 'custom'");
  const palette = styleFunction.indexOf("appendSvgStyle(svgEl, 'theme-colors'");
  const nodeEditor = styleFunction.indexOf("appendSvgStyle(svgEl, 'node-editor'");
  assert.ok(defaults >= 0 && authored > defaults && palette > authored && nodeEditor > palette);
  assert.match(styleFunction, /applyThemeColorsInline\(svgEl\)/);
  assert.match(styleFunction, /applyNodeEditorStylesInline\(svgEl\)/);

  assert.match(getFunction('setTheme', 'detectFlowDirection'), /themeColorsOverrideCustomCss = true/);
});

test('SVG, PNG and PDF all use the selected opaque palette background', () => {
  const exportFunction = getFunction('getExportSvg', 'svgToCanvas');
  assert.match(exportFunction, /class', 'inflow-export-background'/);
  assert.match(exportFunction, /fill', themeColors\.background/);
  assert.match(exportFunction, /background: themeColors\.background/);

  const canvasFunction = getFunction('svgToCanvas', 'normalizePdfConnectors');
  assert.match(canvasFunction, /ctx\.fillStyle = background/);
  assert.match(canvasFunction, /ctx\.fillRect\(0, 0, canvasW, canvasH\)/);

  const exportBranch = getFunction('exportAs', 'downloadFile');
  assert.match(exportBranch, /svgToCanvas\(svgString, width, height, scale, background\)/);
});

test('PDF embeds the styled SVG directly and normalizes connectors as vectors', () => {
  const exportFunction = getFunction('exportAs', 'downloadFile');
  const start = exportFunction.indexOf("if (format === 'pdf')");
  const pdfBranch = exportFunction.slice(start);
  assert.match(pdfBranch, /await pdf\.svg\(svgElement/);
  assert.doesNotMatch(pdfBranch, /addImage|toDataURL|svgToCanvas/);

  const normalizer = getFunction('normalizePdfConnectors', 'exportAs');
  assert.match(normalizer, /getTotalLength\(\)/);
  assert.match(normalizer, /inflow-pdf-arrowhead/);
  assert.match(normalizer, /createElementNS\(SVG_NS, 'polyline'\)/);
  assert.match(normalizer, /removeAttribute\('marker-end'\)/);
  assert.ok(exportFunction.indexOf('normalizePdfConnectors(svgElement)') < exportFunction.indexOf('await pdf.svg(svgElement'));
});

test('Mermaid rendering is serialized to avoid live/export theme races', () => {
  assert.match(appScript, /let mermaidRenderQueue = Promise\.resolve\(\)/);
  assert.match(getFunction('renderMermaid', 'injectStyles'), /mermaidRenderQueue\.then/);
  assert.match(getFunction('getExportSvg', 'svgToCanvas'), /renderMermaid\(exportConfig, exportId, finalCode\)/);
});
