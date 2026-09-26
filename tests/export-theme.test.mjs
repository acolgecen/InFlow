import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const inlineScript = html.slice(
  html.indexOf('<script>\n') + '<script>\n'.length,
  html.lastIndexOf('</script>')
);

test('inline application script is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(inlineScript));
});

test('all themes have deterministic export palettes', () => {
  for (const theme of [
    'default', 'neutral', 'ocean', 'rose', 'sage',
    'dark', 'forest', 'midnight', 'slate', 'mocha'
  ]) {
    assert.match(inlineScript, new RegExp(`'${theme}':\\s*\\{`));
  }
  assert.match(inlineScript, /resolvedThemeColors\[themeKey\]/);
});

test('flowcharts use compact polished layout and presentation defaults', () => {
  assert.match(inlineScript, /curve: 'stepAfter'/);
  assert.match(inlineScript, /nodeSpacing: 32/);
  assert.match(inlineScript, /rankSpacing: 56/);
  assert.match(inlineScript, /function buildPolishedDiagramCss/);
  assert.match(inlineScript, /border-radius: 999px/);
  assert.match(inlineScript, /function applyPolishedSvgGeometry/);
  assert.match(inlineScript, /M 1 1 L 9 5 L 1 9/);
});

test('custom CSS applies on input and a later theme selection can take priority', () => {
  assert.match(inlineScript, /customCssEditor\.addEventListener\('input'/);
  assert.match(inlineScript, /themeColorsOverrideCustomCss = false/);

  const styleFunction = inlineScript.slice(
    inlineScript.indexOf('function applySvgStyleLayers'),
    inlineScript.indexOf('function setTheme')
  );
  assert.ok(styleFunction.indexOf("appendSvgStyle(svgEl, 'custom'") >= 0);
  assert.match(styleFunction, /if \(themeColorsOverrideCustomCss\)/);
  assert.match(styleFunction, /applyThemeColorsInline\(svgEl\)/);

  const setThemeFunction = inlineScript.slice(
    inlineScript.indexOf('function setTheme'),
    inlineScript.indexOf('function setDirection')
  );
  assert.match(setThemeFunction, /themeColorsOverrideCustomCss = true/);
});

test('PDF embeds SVG directly without a raster intermediary', () => {
  const start = inlineScript.indexOf("if (format === 'pdf')");
  const pdfBranch = inlineScript.slice(start, inlineScript.indexOf('} catch (err)', start));
  assert.match(pdfBranch, /await pdf\.svg\(svgElement/);
  assert.doesNotMatch(pdfBranch, /addImage|toDataURL|svgToCanvas/);
});

test('PDF connector markers are normalized into ordinary vector geometry', () => {
  const normalizer = inlineScript.slice(
    inlineScript.indexOf('function normalizePdfConnectors'),
    inlineScript.indexOf('async function exportAs')
  );
  assert.match(normalizer, /getTotalLength\(\)/);
  assert.match(normalizer, /inflow-pdf-arrowhead/);
  assert.match(normalizer, /createElementNS\(SVG_NS, 'polyline'\)/);
  assert.match(normalizer, /removeAttribute\('marker-end'\)/);

  const pdfCall = inlineScript.indexOf('await pdf.svg(svgElement');
  assert.ok(inlineScript.lastIndexOf('normalizePdfConnectors(svgElement)', pdfCall) > 0);
});

test('Mermaid rendering is serialized to avoid theme races', () => {
  assert.match(inlineScript, /let mermaidRenderQueue = Promise\.resolve\(\)/);
  assert.match(inlineScript, /renderMermaid\(exportConfig, exportId, finalCode, currentTheme\)/);
});
