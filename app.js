// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// State
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let currentZoom = 1;
let panX = 0, panY = 0;
let currentTheme = 'dark';
let currentDirection = 'TD';
let selectedNode = null;
let nodeStyles = {};       // nodeId -> {fill, stroke, color}
let renderCounter = 0;
let debounceTimer = null;
let customCssDebounceTimer = null;
let liveRenderVersion = 0;
let mermaidRenderQueue = Promise.resolve();
let themeColorsOverrideCustomCss = false;
let userHasChosenTheme = false;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Init
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const editor = document.getElementById('codeEditor');
const customCssEditor = document.getElementById('customCss');
const preview = document.getElementById('mermaidPreview');
const errorEl = document.getElementById('previewError');

// Auto-render on typing
editor.addEventListener('input', () => {
  syncDirectionFromCode(editor.value);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderDiagram, 500);
});

// Pasting or editing CSS makes it the active style layer immediately. Choosing
// a theme later deliberately reasserts that theme's colors.
customCssEditor.addEventListener('input', () => {
  themeColorsOverrideCustomCss = false;
  clearTimeout(customCssDebounceTimer);
  customCssDebounceTimer = setTimeout(renderDiagram, 100);
});

// Tab key support in editor
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Render
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function renderDiagram() {
  const renderVersion = ++liveRenderVersion;
  const code = editor.value.trim();
  if (!code) {
    preview.innerHTML = '<p style="color:var(--text-dim);font-size:14px;">Enter Mermaid code to see your diagram</p>';
    errorEl.classList.remove('show');
    return;
  }

  // Inject style definitions
  let finalCode = injectStyles(code);

  const id = 'mermaid-' + (++renderCounter);
  try {
    const { svg } = await renderMermaid(buildMermaidConfig(currentTheme), id, finalCode);
    if (renderVersion !== liveRenderVersion) return;
    preview.innerHTML = svg;
    errorEl.classList.remove('show');

    // Keep the exact same CSS cascade in preview, SVG, PNG, and PDF.
    applySvgStyleLayers(preview.querySelector('svg'));

    // Apply zoom + pan
    applyTransform();

    // Parse nodes
    parseAndListNodes(code);

    // Make SVG nodes clickable
    makeNodesClickable();
  } catch (err) {
    errorEl.textContent = err.message || 'Syntax error in Mermaid code';
    errorEl.classList.add('show');
    // Clean up failed render element
    const failedEl = document.getElementById(id);
    if (failedEl) failedEl.remove();
  }
}

// Mermaid configuration is global. Serializing renders prevents a live preview
// and an export from changing each other's theme halfway through an async render.
function renderMermaid(config, id, code) {
  const task = mermaidRenderQueue.then(() => {
    mermaid.initialize(config);
    return mermaid.render(id, code);
  });
  mermaidRenderQueue = task.catch(() => {});
  return task;
}

function injectStyles(code) {
  // Build classDef and style statements from nodeStyles
  const lines = code.split('\n');
  // Remove existing style/classDef lines we manage
  const filtered = lines.filter(l => !l.trim().startsWith('style ') || !l.includes('/*auto*/'));
  let result = filtered.join('\n');

  // Add style statements
  for (const [nodeId, styles] of Object.entries(nodeStyles)) {
    const parts = [];
    if (styles.fill) parts.push(`fill:${styles.fill}`);
    if (styles.stroke) parts.push(`stroke:${styles.stroke}`);
    if (styles.color) parts.push(`color:${styles.color}`);
    if (parts.length) {
      result += `\n    style ${nodeId} ${parts.join(',')} /*auto*/`;
    }
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Parse Nodes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseAndListNodes(code) {
  const nodes = new Map();
  const connections = [];
  const connectionEndpoints = new Set();
  const skipKeywords = new Set(['graph', 'flowchart', 'TD', 'LR', 'BT', 'RL', 'TB', 'style', 'classDef', 'class', 'subgraph', 'end']);
  const lines = code.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%') || trimmed.startsWith('style ') ||
        trimmed.startsWith('classDef ') || trimmed.startsWith('class ') ||
        /^(graph|flowchart)\s/.test(trimmed)) continue;

    // Match node definitions with various shapes
    const nodePatterns = [
      /([A-Za-z_][\w]*)\[\[(.+?)\]\]/g,   // subroutine
      /([A-Za-z_][\w]*)\[\((.+?)\)\]/g,    // cylinder
      /([A-Za-z_][\w]*)\(\[(.+?)\]\)/g,    // stadium
      /([A-Za-z_][\w]*)\(\((.+?)\)\)/g,    // circle
      /([A-Za-z_][\w]*)\{\{(.+?)\}\}/g,    // hexagon
      /([A-Za-z_][\w]*)\{(.+?)\}/g,        // diamond
      /([A-Za-z_][\w]*)\[\/(.+?)\\]/g,     // trapezoid
      /([A-Za-z_][\w]*)\[\/(.+?)\/\]/g,    // parallelogram
      /([A-Za-z_][\w]*)>(.+?)\]/g,         // flag
      /([A-Za-z_][\w]*)\((.+?)\)/g,        // rounded
      /([A-Za-z_][\w]*)\["(.+?)"\]/g,      // rect with quotes
      /([A-Za-z_][\w]*)\[(.+?)\]/g,        // rect
    ];

    // Simple connection parsing - collect endpoints
    const connMatch = trimmed.match(/([A-Za-z_][\w]*)\s*(-->|--[->]|==>|-.->|-.-[->]|~~>|--\s*\|[^|]*\|)\s*([A-Za-z_][\w]*)/);
    if (connMatch) {
      connections.push({ from: connMatch[1], to: connMatch[3], type: connMatch[2] });
      connectionEndpoints.add(connMatch[1]);
      connectionEndpoints.add(connMatch[3]);
    }

    for (const pattern of nodePatterns) {
      let m;
      while ((m = pattern.exec(trimmed)) !== null) {
        if (!nodes.has(m[1])) {
          nodes.set(m[1], { id: m[1], label: m[2].replace(/"/g, '') });
        }
      }
    }
  }

  // Add connection endpoint IDs not already captured with explicit definitions
  for (const id of connectionEndpoints) {
    if (!nodes.has(id) && !skipKeywords.has(id)) {
      nodes.set(id, { id, label: id });
    }
  }

  // Render node list
  const nodeList = document.getElementById('nodeList');
  if (nodes.size === 0) {
    nodeList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">No nodes detected</div>';
    return;
  }

  nodeList.innerHTML = '';
  for (const [id, node] of nodes) {
    const style = nodeStyles[id] || {};
    const color = style.fill || '#6c72ff';
    const el = document.createElement('div');
    el.className = 'node-item' + (selectedNode === id ? ' selected' : '');
    el.innerHTML = `<div class="node-dot" style="background:${color}"></div>
      <span>${node.label}</span>
      <span class="node-id">${id}</span>`;
    el.onclick = () => selectNode(id, node.label);
    nodeList.appendChild(el);
  }

  // Render connections
  const connSection = document.getElementById('connectionSection');
  const connList = document.getElementById('connectionList');
  if (connections.length > 0) {
    connSection.style.display = 'block';
    connList.innerHTML = '';
    connections.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.innerHTML = `<span style="font-size:12px;font-family:monospace;color:var(--text-dim);">${c.from}</span>
        <select style="width:80px;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:11px;" onchange="updateConnection(${i}, this.value)">
          <option value="-->" ${c.type.includes('-->') ? 'selected' : ''}>→ Arrow</option>
          <option value="---" ${c.type === '---' ? 'selected' : ''}>— Line</option>
          <option value="==>" ${c.type === '==>' ? 'selected' : ''}>⇒ Thick</option>
          <option value="-.->" ${c.type.includes('-.') ? 'selected' : ''}>⇢ Dotted</option>
        </select>
        <span style="font-size:12px;font-family:monospace;color:var(--text-dim);">${c.to}</span>`;
      connList.appendChild(row);
    });
  } else {
    connSection.style.display = 'none';
  }
}

function makeNodesClickable() {
  const svgNodes = preview.querySelectorAll('.node');
  svgNodes.forEach(node => {
    node.style.cursor = 'pointer';
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = node.id?.replace(/^flowchart-/, '').replace(/-\d+$/, '');
      if (id) {
        const label = node.querySelector('.nodeLabel')?.textContent || id;
        selectNode(id, label);
      }
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Node Editing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function selectNode(id, label) {
  selectedNode = id;
  document.getElementById('nodePropsSection').style.display = 'block';
  document.getElementById('editNodeId').textContent = id;
  document.getElementById('nodeLabel').value = label;

  // Detect current shape from code
  const shape = detectNodeShape(id);
  document.getElementById('nodeShape').value = shape;

  // Load existing styles
  const style = nodeStyles[id] || {};
  setColorInputs('nodeFill', style.fill || '#6c72ff');
  setColorInputs('nodeStroke', style.stroke || '#4a4fb3');
  setColorInputs('nodeTextColor', style.color || '#ffffff');

  // Highlight in list
  document.querySelectorAll('.node-item').forEach(el => el.classList.remove('selected'));
  const items = document.querySelectorAll('.node-item');
  items.forEach(el => {
    if (el.querySelector('.node-id')?.textContent === id) el.classList.add('selected');
  });
}

function setColorInputs(baseId, value) {
  document.getElementById(baseId).value = value;
  document.getElementById(baseId + 'Text').value = value;
}

function syncColorFromText(baseId) {
  const text = document.getElementById(baseId + 'Text').value;
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    document.getElementById(baseId).value = text;
    updateNodeStyle();
  }
}

function detectNodeShape(id) {
  const code = editor.value;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(escaped + '\\[\\[').test(code)) return 'subroutine';
  if (new RegExp(escaped + '\\[\\(').test(code)) return 'cylinder';
  if (new RegExp(escaped + '\\(\\[').test(code)) return 'stadium';
  if (new RegExp(escaped + '\\(\\(').test(code)) return 'circle';
  if (new RegExp(escaped + '\\{\\{').test(code)) return 'hexagon';
  if (new RegExp(escaped + '\\{').test(code)) return 'diamond';
  if (new RegExp(escaped + '\\[\\/.*\\\\\\/\\]').test(code)) return 'trapezoid';
  if (new RegExp(escaped + '\\[\\/').test(code)) return 'parallelogram';
  if (new RegExp(escaped + '>').test(code)) return 'flag';
  if (new RegExp(escaped + '\\(').test(code)) return 'round';
  if (new RegExp(escaped + '\\[').test(code)) return 'rect';
  return 'rect';
}

function wrapLabel(id, label, shape) {
  const shapes = {
    rect: [`[`, `]`],
    round: [`(`, `)`],
    stadium: [`([`, `])`],
    subroutine: [`[[`, `]]`],
    cylinder: [`[(`, `)]`],
    circle: [`((`, `))`],
    diamond: [`{`, `}`],
    hexagon: [`{{`, `}}`],
    parallelogram: [`[/`, `/]`],
    trapezoid: [`[/`, `\\]`],
    flag: [`>`, `]`],
  };
  const [open, close] = shapes[shape] || shapes.rect;
  return `${id}${open}${label}${close}`;
}

function updateNodeLabel() {
  if (!selectedNode) return;
  const newLabel = document.getElementById('nodeLabel').value;
  const shape = document.getElementById('nodeShape').value;
  replaceNodeInCode(selectedNode, newLabel, shape);
  renderDiagram();
}

function updateNodeShape() {
  if (!selectedNode) return;
  const label = document.getElementById('nodeLabel').value;
  const shape = document.getElementById('nodeShape').value;
  replaceNodeInCode(selectedNode, label, shape);
  renderDiagram();
}

function replaceNodeInCode(nodeId, label, shape) {
  const code = editor.value;
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match node with any shape brackets
  const regex = new RegExp(
    escaped + '(\\[\\[.*?\\]\\]|\\[\\(.*?\\)\\]|\\(\\[.*?\\]\\)|\\(\\(.*?\\)\\)|\\{\\{.*?\\}\\}|\\{.*?\\}|\\[\\/.*?\\\\\\/\\]|\\[\\/.*?\\/\\]|>.*?\\]|\\(.*?\\)|\\[".*?"\\]|\\[.*?\\])',
    'g'
  );
  const replacement = wrapLabel(nodeId, label, shape);

  if (regex.test(code)) {
    editor.value = code.replace(regex, replacement);
  }
}

function updateNodeStyle() {
  if (!selectedNode) return;
  const fill = document.getElementById('nodeFill').value;
  const stroke = document.getElementById('nodeStroke').value;
  const color = document.getElementById('nodeTextColor').value;

  nodeStyles[selectedNode] = { fill, stroke, color };

  // Sync text inputs
  document.getElementById('nodeFillText').value = fill;
  document.getElementById('nodeStrokeText').value = stroke;
  document.getElementById('nodeTextColorText').value = color;

  renderDiagram();
}

function applyPresetColor(fill, stroke) {
  if (!selectedNode) {
    showToast('Select a node first');
    return;
  }
  document.getElementById('nodeFill').value = fill;
  document.getElementById('nodeFillText').value = fill;
  document.getElementById('nodeStroke').value = stroke;
  document.getElementById('nodeStrokeText').value = stroke;
  updateNodeStyle();
}

function updateConnection(index, newType) {
  const code = editor.value;
  const lines = code.split('\n');
  let connIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(/([A-Za-z_][\w]*)\s*(-->|---|==>|-\.->|~~>)\s*([A-Za-z_][\w]*)/)) {
      if (connIdx === index) {
        lines[i] = lines[i].replace(/(-->|---|==>|-\.->|~~>)/, newType);
        break;
      }
      connIdx++;
    }
  }
  editor.value = lines.join('\n');
  renderDiagram();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Theme definitions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const THEME_STORAGE_KEY = 'inflow.theme';

var themeDefinitions = {
  default: {
    name: 'Default', mode: 'light', theme: 'base',
    colors: { primary: '#ffffff', text: '#18181b', border: '#d4d4d8', line: '#71717a', background: '#fafafa', edgeLabel: '#ffffff', cluster: '#f4f4f5' },
    interface: { accent: '#6366f1', accentHover: '#4f46e5', accentRgb: '99, 102, 241' }
  },
  neutral: {
    name: 'Neutral', mode: 'light', theme: 'base',
    colors: { primary: '#f4f4f5', text: '#18181b', border: '#a1a1aa', line: '#71717a', background: '#ffffff', edgeLabel: '#fafafa', cluster: '#f4f4f5' },
    interface: { accent: '#52525b', accentHover: '#3f3f46', accentRgb: '82, 82, 91' }
  },
  ocean: {
    name: 'Ocean', mode: 'light', theme: 'base',
    colors: { primary: '#eaf4ff', text: '#153859', border: '#5b9bd5', line: '#4b82b4', background: '#f5faff', edgeLabel: '#e8f3ff', cluster: '#dceeff' },
    interface: { accent: '#2579bd', accentHover: '#19679f', accentRgb: '37, 121, 189' }
  },
  rose: {
    name: 'Rose', mode: 'light', theme: 'base',
    colors: { primary: '#fff0f5', text: '#6f1d3f', border: '#df6f9b', line: '#b55379', background: '#fff8fa', edgeLabel: '#ffedf4', cluster: '#fbdce8' },
    interface: { accent: '#c24173', accentHover: '#a83262', accentRgb: '194, 65, 115' }
  },
  sage: {
    name: 'Sage', mode: 'light', theme: 'base',
    colors: { primary: '#ecf7ef', text: '#214c32', border: '#70a883', line: '#608e70', background: '#f7fbf8', edgeLabel: '#e9f5ec', cluster: '#d8ecde' },
    interface: { accent: '#3f8a5c', accentHover: '#337349', accentRgb: '63, 138, 92' }
  },
  dark: {
    name: 'Dark', mode: 'dark', theme: 'base',
    colors: { primary: '#262626', text: '#f5f5f5', border: '#525252', line: '#a3a3a3', background: '#171717', edgeLabel: '#202020', cluster: '#222222' },
    interface: { accent: '#7c83ff', accentHover: '#9499ff', accentRgb: '124, 131, 255' }
  },
  forest: {
    name: 'Forest', mode: 'dark', theme: 'base',
    colors: { primary: '#10271a', text: '#dcfce7', border: '#26734a', line: '#78a989', background: '#08140d', edgeLabel: '#0d2115', cluster: '#13301f' },
    interface: { accent: '#45b875', accentHover: '#60cf8e', accentRgb: '69, 184, 117' }
  },
  midnight: {
    name: 'Midnight', mode: 'dark', theme: 'base',
    colors: { primary: '#191b3a', text: '#eef0ff', border: '#555cc7', line: '#9298e8', background: '#0c0d1b', edgeLabel: '#15172e', cluster: '#20234a' },
    interface: { accent: '#7d83ff', accentHover: '#989cff', accentRgb: '125, 131, 255' }
  },
  slate: {
    name: 'Slate', mode: 'dark', theme: 'base',
    colors: { primary: '#263241', text: '#edf2f7', border: '#5d7188', line: '#91a2b5', background: '#101720', edgeLabel: '#202b38', cluster: '#1d2a38' },
    interface: { accent: '#7aa2cc', accentHover: '#91b5da', accentRgb: '122, 162, 204' }
  },
  mocha: {
    name: 'Mocha', mode: 'dark', theme: 'base',
    colors: { primary: '#35251d', text: '#fff4ea', border: '#946446', line: '#c09270', background: '#17100c', edgeLabel: '#2a1d17', cluster: '#2c1e17' },
    interface: { accent: '#cf8b5c', accentHover: '#dda27b', accentRgb: '207, 139, 92' }
  }
};

for (const definition of Object.values(themeDefinitions)) {
  const c = definition.colors;
  definition.themeVariables = {
    primaryColor: c.primary,
    primaryTextColor: c.text,
    primaryBorderColor: c.border,
    lineColor: c.line,
    background: c.background,
    mainBkg: c.primary,
    secondBkg: c.edgeLabel,
    tertiaryColor: c.cluster,
    edgeLabelBackground: c.edgeLabel,
    clusterBkg: c.cluster,
    clusterBorder: c.border,
    titleColor: c.text
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Theme & Direction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildMermaidConfig(themeKey) {
  const def = themeDefinitions[themeKey] || themeDefinitions.default;
  const fontFamily = 'Arial, Helvetica, sans-serif';
  const cfg = {
    startOnLoad: false,
    theme: def.theme,
    securityLevel: 'loose',
    flowchart: {
      curve: 'stepAfter',
      htmlLabels: false,
      useMaxWidth: false,
      nodeSpacing: 32,
      rankSpacing: 56,
      padding: 16
    },
    fontFamily
  };
  cfg.themeVariables = {
    ...(def.themeVariables || {}),
    fontFamily,
    fontSize: '16px'
  };
  return cfg;
}

function getThemeColors(themeKey = currentTheme) {
  const def = themeDefinitions[themeKey] || themeDefinitions.default;
  return def.colors;
}

function safeReadSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return themeDefinitions[saved] ? saved : null;
  } catch (_) {
    return null;
  }
}

function saveThemePreference(themeKey) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeKey);
  } catch (_) {
    // Local file privacy settings can disable storage; the session still works.
  }
}

function resolveInitialTheme() {
  const saved = safeReadSavedTheme();
  if (saved) {
    userHasChosenTheme = true;
    return saved;
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'default';
}

function applyInterfaceTheme(themeKey, persist = false) {
  const definition = themeDefinitions[themeKey] || themeDefinitions.default;
  const root = document.documentElement;
  root.dataset.colorMode = definition.mode;
  root.dataset.theme = themeKey;
  root.style.setProperty('--accent', definition.interface.accent);
  root.style.setProperty('--accent-hover', definition.interface.accentHover);
  root.style.setProperty('--accent-rgb', definition.interface.accentRgb);
  root.style.setProperty('--preview-bg', definition.colors.background);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', definition.colors.background);

  document.querySelectorAll('.theme-card').forEach(card => {
    const active = card.dataset.theme === themeKey;
    card.classList.toggle('active', active);
    card.setAttribute('aria-pressed', String(active));
  });

  if (persist) {
    userHasChosenTheme = true;
    saveThemePreference(themeKey);
  }
}

function renderThemePicker() {
  const grids = {
    light: document.getElementById('lightThemeGrid'),
    dark: document.getElementById('darkThemeGrid')
  };
  Object.values(grids).forEach(grid => { grid.innerHTML = ''; });

  for (const [key, definition] of Object.entries(themeDefinitions)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.theme = key;
    card.setAttribute('aria-pressed', 'false');
    card.setAttribute('aria-label', `Use ${definition.name} theme`);
    card.innerHTML = `
      <span class="theme-swatch" aria-hidden="true" style="--swatch-bg:${definition.colors.background};--swatch-node:${definition.colors.primary};--swatch-border:${definition.colors.border}"></span>
      <span class="theme-card-name">${definition.name}</span>
      <span class="theme-check" aria-hidden="true">✓</span>`;
    card.addEventListener('click', () => setTheme(key));
    grids[definition.mode].appendChild(card);
  }
}

function buildThemeColorOverrideCss(themeKey = currentTheme) {
  const c = getThemeColors(themeKey);
  return `
    .node rect, .node circle, .node ellipse, .node polygon, .node path,
    .node .label-container {
      fill: ${c.primary} !important;
      stroke: ${c.border} !important;
    }
    .nodeLabel, .node text, .node tspan, .node span, .node foreignObject,
    .cluster-label, .cluster-label text, .cluster-label span {
      color: ${c.text} !important;
      fill: ${c.text} !important;
    }
    .edgePath path, path.flowchart-link {
      stroke: ${c.line} !important;
    }
    marker path, .arrowMarkerPath {
      stroke: ${c.line} !important;
    }
    marker[id*="point"] path, marker[id*="Point"] path {
      fill: none !important;
    }
    .edgeLabel, .edgeLabel span, .edgeLabel text {
      color: ${c.text} !important;
      fill: ${c.text} !important;
      background-color: ${c.edgeLabel} !important;
    }
    .edgeLabel rect, .labelBkg {
      fill: ${c.edgeLabel} !important;
    }
    .cluster rect {
      fill: ${c.cluster} !important;
      stroke: ${c.border} !important;
    }
  `;
}

function buildPolishedDiagramCss(themeKey = currentTheme) {
  const c = getThemeColors(themeKey);
  return `
    .node rect, .node circle, .node ellipse, .node polygon, .node path {
      stroke-width: 1.5px;
      stroke-linejoin: round;
    }
    .node rect {
      rx: 12px;
      ry: 12px;
    }
    .nodeLabel, .node text, .node tspan, .node span,
    .edgeLabel, .edgeLabel text, .edgeLabel tspan, .edgeLabel span {
      font-weight: 600;
      letter-spacing: -0.01em;
      text-rendering: geometricPrecision;
    }
    .edgePath path, path.flowchart-link {
      stroke-width: 1.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    marker path, .arrowMarkerPath {
      stroke-width: 1px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    marker[id*="point"] path, marker[id*="Point"] path {
      fill: none;
    }
    .edgeLabel foreignObject {
      overflow: visible;
    }
    .edgeLabel span, .edgeLabel p {
      display: inline-block;
      padding: 3px 8px;
      border: 1px solid ${c.border};
      border-radius: 999px;
      background: ${c.edgeLabel};
      color: ${c.text};
      line-height: 1.2;
    }
    .edgeLabel rect, .labelBkg {
      fill: ${c.edgeLabel};
      stroke: ${c.border};
      stroke-width: 1px;
      rx: 999px;
      ry: 999px;
    }
  `;
}

function buildNodeEditorOverrideCss() {
  const escapeId = value => window.CSS && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  return Object.entries(nodeStyles).map(([nodeId, styles]) => {
    const selector = `.node[id^="flowchart-${escapeId(nodeId)}-"]`;
    const shapeRules = [];
    const textRules = [];
    if (styles.fill) shapeRules.push(`fill:${styles.fill} !important`);
    if (styles.stroke) shapeRules.push(`stroke:${styles.stroke} !important`);
    if (styles.color) {
      textRules.push(`color:${styles.color} !important`);
      textRules.push(`fill:${styles.color} !important`);
    }

    return `
      ${selector} rect, ${selector} circle, ${selector} ellipse,
      ${selector} polygon, ${selector} path, ${selector} .label-container {
        ${shapeRules.join(';')}
      }
      ${selector} .nodeLabel, ${selector} text, ${selector} tspan,
      ${selector} span, ${selector} foreignObject {
        ${textRules.join(';')}
      }
    `;
  }).join('\n');
}

function appendSvgStyle(svgEl, layer, cssText) {
  if (!svgEl || !cssText.trim()) return;
  const styleEl = svgEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.setAttribute('type', 'text/css');
  styleEl.setAttribute('data-inflow-style', layer);
  styleEl.textContent = cssText;
  svgEl.appendChild(styleEl);
}

function setImportantSvgStyles(svgEl, selector, declarations) {
  svgEl.querySelectorAll(selector).forEach(el => {
    for (const [property, value] of Object.entries(declarations)) {
      if (el.style && typeof el.style.setProperty === 'function') {
        el.style.setProperty(property, value, 'important');
      } else {
        const current = el.getAttribute('style') || '';
        el.setAttribute('style', `${current};${property}:${value} !important`);
      }
    }
  });
}

function applyThemeColorsInline(svgEl) {
  const c = getThemeColors();
  setImportantSvgStyles(svgEl,
    '.node rect, .node circle, .node ellipse, .node polygon, .node path, .node .label-container',
    { fill: c.primary, stroke: c.border }
  );
  setImportantSvgStyles(svgEl,
    '.nodeLabel, .node text, .node tspan, .node span, .node foreignObject, .cluster-label, .cluster-label text, .cluster-label span',
    { color: c.text, fill: c.text }
  );
  setImportantSvgStyles(svgEl, '.edgePath path, path.flowchart-link', { stroke: c.line });
  setImportantSvgStyles(svgEl, 'marker path, .arrowMarkerPath', { stroke: c.line });
  setImportantSvgStyles(svgEl, 'marker[id*="point"] path, marker[id*="Point"] path', { fill: 'none' });
  setImportantSvgStyles(svgEl, '.edgeLabel, .edgeLabel span, .edgeLabel text', {
    color: c.text,
    fill: c.text,
    'background-color': c.edgeLabel
  });
  setImportantSvgStyles(svgEl, '.edgeLabel rect, .labelBkg', { fill: c.edgeLabel });
  setImportantSvgStyles(svgEl, '.cluster rect', { fill: c.cluster, stroke: c.border });
}

function applyNodeEditorStylesInline(svgEl) {
  const escapeId = value => window.CSS && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  for (const [nodeId, styles] of Object.entries(nodeStyles)) {
    const selector = `.node[id^="flowchart-${escapeId(nodeId)}-"]`;
    const shapeStyles = {};
    const textStyles = {};
    if (styles.fill) shapeStyles.fill = styles.fill;
    if (styles.stroke) shapeStyles.stroke = styles.stroke;
    if (styles.color) {
      textStyles.color = styles.color;
      textStyles.fill = styles.color;
    }
    setImportantSvgStyles(svgEl,
      `${selector} rect, ${selector} circle, ${selector} ellipse, ${selector} polygon, ${selector} path, ${selector} .label-container`,
      shapeStyles
    );
    setImportantSvgStyles(svgEl,
      `${selector} .nodeLabel, ${selector} text, ${selector} tspan, ${selector} span, ${selector} foreignObject`,
      textStyles
    );
  }
}

function applyPolishedSvgGeometry(svgEl) {
  svgEl.querySelectorAll('marker[id*="point"] path, marker[id*="Point"] path').forEach(path => {
    path.setAttribute('d', 'M 1 1 L 9 5 L 1 9');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  });

  svgEl.querySelectorAll('.node rect').forEach(rect => {
    const height = parseFloat(rect.getAttribute('height')) || 36;
    const existingRadius = parseFloat(rect.getAttribute('rx')) || 0;
    const radius = Math.max(existingRadius, Math.min(12, height / 3));
    rect.setAttribute('rx', radius);
    rect.setAttribute('ry', radius);
  });

  // Text-label exports use SVG background rectangles. Expand those rectangles
  // into pills while leaving the label centered in its original position.
  svgEl.querySelectorAll('.edgeLabel rect, .edgeLabel .labelBkg').forEach(rect => {
    if (rect.hasAttribute('data-inflow-polished')) return;
    const x = parseFloat(rect.getAttribute('x'));
    const y = parseFloat(rect.getAttribute('y'));
    const width = parseFloat(rect.getAttribute('width'));
    const height = parseFloat(rect.getAttribute('height'));
    if ([x, y, width, height].every(Number.isFinite)) {
      rect.setAttribute('x', x - 7);
      rect.setAttribute('y', y - 4);
      rect.setAttribute('width', width + 14);
      rect.setAttribute('height', height + 8);
    }
    rect.setAttribute('rx', 999);
    rect.setAttribute('ry', 999);
    rect.setAttribute('data-inflow-polished', 'true');
  });
}

function applySvgStyleLayers(svgEl) {
  if (!svgEl) return;
  svgEl.querySelectorAll('[data-inflow-style]').forEach(el => el.remove());

  // The structural polish layer establishes compact, legible defaults. User
  // CSS follows it and can still override any of these presentation choices.
  appendSvgStyle(svgEl, 'polished', buildPolishedDiagramCss());
  applyPolishedSvgGeometry(svgEl);

  // Freshly edited CSS wins immediately. Selecting a theme afterward locks its
  // colors over custom color rules while preserving non-color CSS properties.
  const customCss = customCssEditor.value.trim();
  appendSvgStyle(svgEl, 'custom', customCss);
  if (themeColorsOverrideCustomCss) {
    appendSvgStyle(svgEl, 'theme-colors', buildThemeColorOverrideCss());
    applyThemeColorsInline(svgEl);
  }

  // Explicit node edits made in the UI remain the final, most specific layer.
  appendSvgStyle(svgEl, 'node-editor', buildNodeEditorOverrideCss());
  applyNodeEditorStylesInline(svgEl);
}

function setTheme(themeKey) {
  if (!themeDefinitions[themeKey]) return;
  currentTheme = themeKey;
  themeColorsOverrideCustomCss = true;
  applyInterfaceTheme(themeKey, true);
  renderDiagram();
}

const directionLabels = {
  TD: 'Top down',
  LR: 'Left to right',
  BT: 'Bottom up',
  RL: 'Right to left'
};

function detectFlowDirection(code) {
  const match = code.match(/^[\t ]*(?:flowchart|graph)[\t ]+(TD|TB|BT|LR|RL)\b/im);
  if (!match) return null;
  const direction = match[1].toUpperCase();
  return direction === 'TB' ? 'TD' : direction;
}

function updateDirectionUi(direction, isDefault = false) {
  currentDirection = direction;
  document.querySelectorAll('.direction-chip').forEach(chip => {
    const active = chip.dataset.dir === direction;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  const suffix = isDefault ? ' · default' : '';
  document.getElementById('directionStatus').textContent = `Detected: ${directionLabels[direction]} (${direction})${suffix}`;
}

function syncDirectionFromCode(code, useDefaultWhenMissing = true) {
  const detected = detectFlowDirection(code);
  if (detected) {
    updateDirectionUi(detected, false);
    return detected;
  }

  // Keep the last valid choice while the user is midway through a declaration.
  if (/^[\t ]*(?:flowchart|graph)\b/im.test(code)) return currentDirection;
  if (useDefaultWhenMissing) updateDirectionUi('TD', true);
  return null;
}

function setDirection(dir) {
  if (!directionLabels[dir]) return;
  const code = editor.value;
  const declaration = /^[\t ]*(graph|flowchart)[\t ]+(TD|TB|LR|BT|RL)\b/im;
  const newCode = declaration.test(code)
    ? code.replace(declaration, match => match.replace(/(TD|TB|LR|BT|RL)\b/i, dir))
    : `flowchart ${dir}\n${code}`;
  editor.value = newCode;
  updateDirectionUi(dir, false);
  renderDiagram();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Zoom & Pan
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function zoomIn() { setZoom(currentZoom + 0.15); }
function zoomOut() { setZoom(currentZoom - 0.15); }

function resetZoom() {
  // Fit: measure the SVG's intrinsic size vs. the visible container
  const container = document.getElementById('previewContainer');
  const svgEl = preview.querySelector('svg');
  if (!svgEl) { setZoom(1); return; }

  // Get the SVG's natural dimensions from viewBox or attributes
  let svgW, svgH;
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number);
    svgW = parts[2];
    svgH = parts[3];
  }
  if (!svgW) svgW = parseFloat(svgEl.getAttribute('width')) || svgEl.getBoundingClientRect().width / currentZoom;
  if (!svgH) svgH = parseFloat(svgEl.getAttribute('height')) || svgEl.getBoundingClientRect().height / currentZoom;

  // Available space (subtract padding)
  const pad = 40;
  const availW = container.clientWidth - pad * 2;
  const availH = container.clientHeight - pad * 2;

  if (svgW <= 0 || svgH <= 0 || availW <= 0 || availH <= 0) { panX = 0; panY = 0; setZoom(1); return; }

  const scaleToFit = Math.min(availW / svgW, availH / svgH);
  // Don't zoom in beyond 100% — only shrink to fit if needed
  panX = 0; panY = 0;
  setZoom(Math.min(scaleToFit, 1));
}

function setZoom(z) {
  currentZoom = Math.max(0.05, Math.min(5, z));
  applyTransform();
  document.getElementById('zoomLabel').textContent = Math.round(currentZoom * 100) + '%';
}

function applyTransform() {
  preview.style.transform = `translate(${panX}px, ${panY}px) scale(${currentZoom})`;
}

// Mouse wheel zoom
document.getElementById('previewContainer').addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(currentZoom + (e.deltaY > 0 ? -0.08 : 0.08));
}, { passive: false });

// Drag to pan
(function() {
  const container = document.getElementById('previewContainer');
  let isPanning = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;

  container.addEventListener('mousedown', (e) => {
    // Only pan with left button; ignore clicks on SVG nodes (they have their own handler)
    if (e.button !== 0) return;
    if (e.target.closest('.node')) return;
    isPanning = true;
    startX = e.clientX;
    startY = e.clientY;
    startPanX = panX;
    startPanY = panY;
    container.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = startPanX + (e.clientX - startX);
    panY = startPanY + (e.clientY - startY);
    applyTransform();
  });

  document.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    container.style.cursor = '';
  });
})();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Panel resize
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const resizeHandle = document.getElementById('resizeHandle');
const editorPanel = document.getElementById('editorPanel');
let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeHandle.classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newWidth = Math.max(280, Math.min(600, e.clientX));
  editorPanel.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    resizeHandle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tabs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Templates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var templates = {
  blank: `flowchart TD\n    A[Start] --> B[End]`,
  simple: `flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process A]
    B -->|No| D[Process B]
    C --> E[Result]
    D --> E
    E --> F[End]`,
  decision: `flowchart TD
    Q1{Is it urgent?}
    Q1 -->|Yes| Q2{Is it important?}
    Q1 -->|No| Q3{Is it important?}
    Q2 -->|Yes| A1[Do it now]
    Q2 -->|No| A2[Delegate it]
    Q3 -->|Yes| A3[Schedule it]
    Q3 -->|No| A4[Eliminate it]`,
  process: `flowchart LR
    REQ[Request Received] --> REV[Review Request]
    REV --> VAL{Valid?}
    VAL -->|Yes| PROC[Process Request]
    VAL -->|No| REJ[Reject & Notify]
    PROC --> QA[Quality Check]
    QA --> PASS{Pass?}
    PASS -->|Yes| SHIP[Ship / Deploy]
    PASS -->|No| FIX[Fix Issues]
    FIX --> QA
    SHIP --> DONE[Complete]`,
  cicd: `flowchart LR
    DEV[Developer Push] --> BUILD[Build]
    BUILD --> TEST[Run Tests]
    TEST --> PASS{Tests Pass?}
    PASS -->|Yes| STAGE[Deploy Staging]
    PASS -->|No| FIX[Fix & Retry]
    FIX --> BUILD
    STAGE --> REVIEW[Code Review]
    REVIEW --> APPROVE{Approved?}
    APPROVE -->|Yes| PROD[Deploy Production]
    APPROVE -->|No| FIX
    PROD --> MONITOR[Monitor]`,
  userflow: `flowchart TD
    LAND[Landing Page] --> CTA[Click Sign Up]
    CTA --> REG[Registration Form]
    REG --> VERIFY[Email Verification]
    VERIFY --> ONBOARD[Onboarding Flow]
    ONBOARD --> DASH[Dashboard]
    DASH --> EXPLORE[Explore Features]
    EXPLORE --> UPGRADE{Upgrade?}
    UPGRADE -->|Yes| PAY[Payment]
    UPGRADE -->|No| FREE[Continue Free]
    PAY --> PREMIUM[Premium Dashboard]
    FREE --> DASH`,
  architecture: `flowchart TD
    CLIENT[Client App] --> LB[Load Balancer]
    LB --> API1[API Server 1]
    LB --> API2[API Server 2]
    API1 --> CACHE[(Redis Cache)]
    API2 --> CACHE
    API1 --> DB[(PostgreSQL)]
    API2 --> DB
    API1 --> QUEUE[Message Queue]
    QUEUE --> WORKER[Background Workers]
    WORKER --> DB
    WORKER --> S3[(Object Storage)]`
};

function loadTemplate(name) {
  nodeStyles = {};
  selectedNode = null;
  document.getElementById('nodePropsSection').style.display = 'none';
  editor.value = templates[name] || templates.blank;
  syncDirectionFromCode(editor.value);
  renderDiagram();
  switchTab('nodes');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Format code
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function formatCode() {
  const lines = editor.value.split('\n');
  const formatted = lines.map((line, i) => {
    const trimmed = line.trim();
    if (i === 0) return trimmed; // graph/flowchart header
    if (!trimmed) return '';
    if (trimmed.startsWith('%%')) return '    ' + trimmed;
    return '    ' + trimmed;
  });
  editor.value = formatted.join('\n');
  syncDirectionFromCode(editor.value);
  renderDiagram();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function openExportModal() { document.getElementById('exportModal').classList.add('show'); }
function closeExportModal() { document.getElementById('exportModal').classList.remove('show'); }

// Click outside modal to close
document.getElementById('exportModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('exportModal')) closeExportModal();
});

// ── High-quality export pipeline ──
// Strategy:
//   1. Re-render mermaid with htmlLabels:false (no <foreignObject> = canvas-safe)
//   2. Apply the same custom CSS and theme override layers used by the preview
//   3. Insert SVG into DOM offscreen to get its true pixel bounding box
//   4. Rebuild a self-contained SVG with an explicit viewBox, fonts, and theme bg
//   5. For PNG: render to an oversized canvas at the requested DPI scale
//   6. For PDF: embed that SVG directly as vector artwork (never via PNG)
//   7. For SVG: deliver the same self-contained SVG directly

var EXPORT_PADDING = 40; // px padding around diagram content

async function getExportSvg() {
  const code = editor.value.trim();
  if (!code) return null;

  // ── 1. Re-render with htmlLabels OFF (no foreignObject) ──
  const exportConfig = buildMermaidConfig(currentTheme);

  const exportId = 'mermaid-export-' + (++renderCounter);
  let svgMarkup;
  try {
    const finalCode = injectStyles(code);
    const result = await renderMermaid(exportConfig, exportId, finalCode);
    svgMarkup = result.svg;
  } catch (err) {
    console.error('Export render failed:', err);
    return null;
  }

  // ── 2. Create the styled, self-contained SVG used by every export ──
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
  const rootSvg = doc.querySelector('svg');
  if (!rootSvg || doc.querySelector('parsererror')) return null;
  applySvgStyleLayers(rootSvg);

  const serializer = new XMLSerializer();
  svgMarkup = serializer.serializeToString(rootSvg);

  // ── 3. Measure the real bounding box by inserting into DOM ──
  const measurer = document.createElement('div');
  measurer.style.cssText = 'position:fixed;top:-99999px;left:-99999px;visibility:hidden;pointer-events:none;';
  measurer.innerHTML = svgMarkup;
  document.body.appendChild(measurer);

  const svgEl = measurer.querySelector('svg');
  if (!svgEl) { document.body.removeChild(measurer); return null; }

  // Remove any max-width / width:100% that mermaid adds — we need intrinsic size
  svgEl.style.maxWidth = 'none';
  svgEl.style.width = 'auto';
  svgEl.style.height = 'auto';
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');

  // Force layout reflow so getBBox works
  void svgEl.getBoundingClientRect();
  let bbox;
  try {
    bbox = svgEl.getBBox();
  } catch (e) {
    // Fallback: parse viewBox
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const p = vb.split(/[\s,]+/).map(Number);
      bbox = { x: p[0] || 0, y: p[1] || 0, width: p[2] || 800, height: p[3] || 600 };
    } else {
      bbox = { x: 0, y: 0, width: 800, height: 600 };
    }
  }

  document.body.removeChild(measurer);

  // ── 4. Finish the clean self-contained SVG ──
  const pad = EXPORT_PADDING;
  const contentW = bbox.width;
  const contentH = bbox.height;
  const totalW = contentW + pad * 2;
  const totalH = contentH + pad * 2;

  // Set tight viewBox with padding, and explicit width/height in px
  rootSvg.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${totalW} ${totalH}`);
  rootSvg.setAttribute('width', totalW);
  rootSvg.setAttribute('height', totalH);
  rootSvg.removeAttribute('style'); // strip mermaid's max-width style
  rootSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  rootSvg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Use the selected theme background in every exported format.
  const themeColors = getThemeColors();
  const bgRect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('class', 'inflow-export-background');
  bgRect.setAttribute('x', bbox.x - pad);
  bgRect.setAttribute('y', bbox.y - pad);
  bgRect.setAttribute('width', totalW);
  bgRect.setAttribute('height', totalH);
  bgRect.setAttribute('fill', themeColors.background);
  rootSvg.insertBefore(bgRect, rootSvg.firstChild);

  // Embed font declaration so text renders identically everywhere
  const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = `
    text, tspan, .nodeLabel, .edgeLabel, .label {
      font-family: Arial, Helvetica, sans-serif !important;
    }
  `;
  rootSvg.insertBefore(styleEl, rootSvg.firstChild);

  const svgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializer.serializeToString(rootSvg);

  return { svgString, width: totalW, height: totalH, background: themeColors.background };
}

// Render SVG string to a high-res canvas, returns a Promise<Canvas>
function svgToCanvas(svgString, width, height, scale, background) {
  return new Promise((resolve, reject) => {
    const canvasW = Math.ceil(width * scale);
    const canvasH = Math.ceil(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');

    // Match the selected palette to avoid light seams on dark exports.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Enable high-quality image interpolation
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvasW, canvasH);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error('Failed to rasterize SVG'));

    // Encode as base64 data URI — avoids all blob/CORS/taint issues
    const encoded = btoa(unescape(encodeURIComponent(svgString)));
    img.src = 'data:image/svg+xml;base64,' + encoded;
  });
}

// svg2pdf can render Mermaid marker arrowheads while omitting their linked
// connector paths. For PDF only, replace marker references with ordinary SVG
// geometry so the line and arrowhead are handled by the same vector pipeline.
function normalizePdfConnectors(svgEl) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const connectors = svgEl.querySelectorAll('.edgePath path, path.flowchart-link');

  connectors.forEach(path => {
    const computed = window.getComputedStyle(path);
    const stroke = computed.stroke && computed.stroke !== 'none'
      ? computed.stroke
      : (path.getAttribute('stroke') || getThemeColors().line);
    const strokeWidth = Math.max(1, parseFloat(computed.strokeWidth) || 1.5);

    // Copy computed CSS into presentation attributes understood consistently
    // by both the browser SVG renderer and svg2pdf.
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', strokeWidth);
    path.setAttribute('stroke-linecap', computed.strokeLinecap || 'round');
    path.setAttribute('stroke-linejoin', computed.strokeLinejoin || 'round');
    const pdfPathStyles = [
      'fill:none',
      `stroke:${stroke}`,
      `stroke-width:${strokeWidth}`,
      `stroke-linecap:${computed.strokeLinecap || 'round'}`,
      `stroke-linejoin:${computed.strokeLinejoin || 'round'}`,
      `stroke-opacity:${computed.strokeOpacity || '1'}`,
      `opacity:${computed.opacity || '1'}`
    ];
    if (computed.strokeDasharray && computed.strokeDasharray !== 'none') {
      path.setAttribute('stroke-dasharray', computed.strokeDasharray);
      path.setAttribute('stroke-dashoffset', computed.strokeDashoffset || '0');
      pdfPathStyles.push(`stroke-dasharray:${computed.strokeDasharray}`);
      pdfPathStyles.push(`stroke-dashoffset:${computed.strokeDashoffset || '0'}`);
    }
    // Avoid converter-specific handling of CSS !important by reducing each
    // connector to a simple, explicit inline vector style.
    path.setAttribute('style', pdfPathStyles.join(';'));

    const markerStart = path.getAttribute('marker-start') || computed.markerStart;
    const markerEnd = path.getAttribute('marker-end') || computed.markerEnd;
    let length;
    try {
      length = path.getTotalLength();
    } catch (_) {
      return;
    }
    if (!Number.isFinite(length) || length <= 0) return;

    const addArrowhead = atEnd => {
      const tipDistance = atEnd ? length : 0;
      const innerDistance = atEnd ? Math.max(0, length - 2) : Math.min(length, 2);
      const tip = path.getPointAtLength(tipDistance);
      const inner = path.getPointAtLength(innerDistance);
      let dx = tip.x - inner.x;
      let dy = tip.y - inner.y;
      const magnitude = Math.hypot(dx, dy) || 1;
      const ux = dx / magnitude;
      const uy = dy / magnitude;
      const arrowLength = Math.max(8, strokeWidth * 4.5);
      const halfWidth = Math.max(4, strokeWidth * 2.25);
      const baseX = tip.x - ux * arrowLength;
      const baseY = tip.y - uy * arrowLength;
      const px = -uy * halfWidth;
      const py = ux * halfWidth;

      const arrow = document.createElementNS(SVG_NS, 'polyline');
      arrow.setAttribute('class', 'inflow-pdf-arrowhead');
      arrow.setAttribute('points', [
        `${baseX + px},${baseY + py}`,
        `${tip.x},${tip.y}`,
        `${baseX - px},${baseY - py}`
      ].join(' '));
      arrow.setAttribute('fill', 'none');
      arrow.setAttribute('stroke', stroke);
      arrow.setAttribute('stroke-width', strokeWidth);
      arrow.setAttribute('stroke-linecap', 'round');
      arrow.setAttribute('stroke-linejoin', 'round');
      if (path.hasAttribute('transform')) {
        arrow.setAttribute('transform', path.getAttribute('transform'));
      }
      path.parentNode.appendChild(arrow);
    };

    if (markerStart && markerStart !== 'none') addArrowhead(false);
    if (markerEnd && markerEnd !== 'none') addArrowhead(true);

    path.removeAttribute('marker-start');
    path.removeAttribute('marker-end');
    path.style.removeProperty('marker-start');
    path.style.removeProperty('marker-end');
  });
}

async function exportAs(format) {
  closeExportModal();
  showToast('Preparing high-quality export...');

  const data = await getExportSvg();
  if (!data) {
    showToast('No diagram to export — render your diagram first.');
    return;
  }

  const { svgString, width, height, background } = data;

  // ── SVG ──
  if (format === 'svg') {
    downloadFile(svgString, 'diagram.svg', 'image/svg+xml');
    showToast('SVG exported — full vector quality');
    return;
  }

  try {
    // ── PNG ──
    if (format === 'png') {
      const scale = parseInt(document.getElementById('exportScale').value) || 2;
      const canvas = await svgToCanvas(svgString, width, height, scale, background);
      canvas.toBlob((blob) => {
        if (!blob) { showToast('PNG export failed'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagram.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const pxW = Math.ceil(width * scale);
        const pxH = Math.ceil(height * scale);
        showToast(`PNG exported — ${pxW}×${pxH}px at ${scale}x`);
      }, 'image/png');
    }

    // ── PDF ──
    if (format === 'pdf') {
      const { jsPDF } = window.jspdf;
      if (!jsPDF || typeof jsPDF.API.svg !== 'function') {
        throw new Error('Vector PDF support did not load. Please refresh and try again.');
      }

      // Build a page around the SVG at its natural 96-DPI dimensions.
      const PX_TO_MM = 25.4 / 96;
      const svgWidthMM = width * PX_TO_MM;
      const svgHeightMM = height * PX_TO_MM;
      const marginMM = 10;
      const pageW = Math.max(210, svgWidthMM + marginMM * 2);
      const pageH = Math.max(297, svgHeightMM + marginMM * 2);
      const orientation = pageW > pageH ? 'landscape' : 'portrait';
      const pdf = new jsPDF({ orientation, unit: 'mm', format: [pageW, pageH] });

      const actualPageW = pdf.internal.pageSize.getWidth();
      const actualPageH = pdf.internal.pageSize.getHeight();
      const fitScale = Math.min(
        1,
        (actualPageW - marginMM * 2) / svgWidthMM,
        (actualPageH - marginMM * 2) / svgHeightMM
      );
      const drawW = svgWidthMM * fitScale;
      const drawH = svgHeightMM * fitScale;
      const offX = (actualPageW - drawW) / 2;
      const offY = (actualPageH - drawH) / 2;

      const svgDoc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
      const svgElement = document.importNode(svgDoc.documentElement, true);
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-99999px;top:0;pointer-events:none;';
      holder.appendChild(svgElement);
      document.body.appendChild(holder);
      try {
        normalizePdfConnectors(svgElement);
        await pdf.svg(svgElement, { x: offX, y: offY, width: drawW, height: drawH });
      } finally {
        holder.remove();
      }
      pdf.save('diagram.pdf');
      showToast('PDF exported — SVG embedded at vector quality');
    }
  } catch (err) {
    console.error('Export error:', err);
    showToast('Export failed: ' + err.message);
  }
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Toast notification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Keyboard shortcuts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Enter to render
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    renderDiagram();
  }
  // Ctrl/Cmd + E to export
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    openExportModal();
  }
  // Escape to close modal
  if (e.key === 'Escape') {
    closeExportModal();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Boot — load default template after everything is defined
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
renderThemePicker();
currentTheme = resolveInitialTheme();
applyInterfaceTheme(currentTheme, false);

const systemColorPreference = window.matchMedia?.('(prefers-color-scheme: dark)');
systemColorPreference?.addEventListener?.('change', event => {
  if (userHasChosenTheme) return;
  currentTheme = event.matches ? 'dark' : 'default';
  applyInterfaceTheme(currentTheme, false);
  renderDiagram();
});

loadTemplate('simple');
