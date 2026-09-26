# InFlow

A browser-based flowchart builder powered by [Mermaid](https://mermaid.js.org/). Write Mermaid syntax in the code editor and get an interactive, styled preview in real time — no installation required.

**[Try it live →](https://acolgecen.github.io/Inflow/)**

## Features

### Editor
- Live syntax editor with auto-render on typing (500 ms debounce)
- Tab key support for indentation
- **Format** button to auto-indent the diagram code
- Resizable editor panel (drag the right edge)

### Preview
- Real-time diagram rendering via Mermaid 10
- Polished flowchart defaults with compact spacing, rounded cards, orthogonal connectors, pill labels, and stronger typography
- **Zoom in / Zoom out** controls (+/- buttons or mouse wheel)
- **Fit** button to auto-scale the diagram to the available viewport
- **Drag to pan** — click and drag anywhere in the preview to navigate
- Syntax error display shown inline below the preview

### Nodes Panel
- Lists all nodes detected in the current diagram
- Click any node in the list (or directly in the diagram) to select it
- Edit the selected node's **label**, **shape**, **fill color**, **stroke color**, and **text color**
- Eight preset color swatches for quick styling
- Connection editor — change arrow types (Arrow, Line, Thick, Dotted) for each detected edge

### Style Panel
- **Diagram Theme** — 10 themes grouped by tone:
  - Light: Default, Neutral, Ocean, Rose, Sage
  - Dark: Dark, Forest, Midnight, Slate, Mocha
- **Flow Direction** — TD (top-down), LR (left-right), BT (bottom-top), RL (right-left)
- **Custom CSS** — inject arbitrary SVG styles into the rendered diagram
- Custom CSS applies as it is entered; selecting a theme afterward reasserts that theme's colors while retaining non-color CSS

### Templates
Six ready-made starting points:
| Template | Description |
|---|---|
| Simple Flow | Basic linear flow with a decision branch |
| Decision Tree | Priority/urgency decision matrix |
| Process Map | Request processing with QA loop |
| CI/CD Pipeline | Build → Test → Stage → Deploy workflow |
| User Flow | Signup, onboarding, and upgrade journey |
| Architecture | Load-balanced API + database + queue setup |

### Export
- **SVG** — clean, scalable vector file
- **PNG** — high-resolution raster with the selected theme background
- **PDF** — the styled SVG is embedded directly as vector artwork
- Resolution scale options for PNG: 2x, 3x, 4x (default), 6x, 8x

## Usage

Open `index.html` directly in any modern browser — no build step, no server needed.

```
open index.html
```

Run the export/theme regression checks with:

```bash
node --test tests/export-theme.test.mjs
```

### Supported Node Shapes

| Syntax | Shape |
|---|---|
| `A[Label]` | Rectangle |
| `A(Label)` | Rounded |
| `A([Label])` | Stadium |
| `A[[Label]]` | Subroutine |
| `A[(Label)]` | Cylinder |
| `A((Label))` | Circle |
| `A{Label}` | Diamond |
| `A{{Label}}` | Hexagon |
| `A[/Label/]` | Parallelogram |
| `A[/Label\]` | Trapezoid |
| `A>Label]` | Flag |

### Supported Connection Types

| Syntax | Style |
|---|---|
| `-->` | Arrow |
| `---` | Line |
| `==>` | Thick arrow |
| `-.->` | Dotted arrow |

## Dependencies

All loaded via CDN — no npm install required.

| Library | Version | Purpose |
|---|---|---|
| [Mermaid](https://mermaid.js.org/) | 10.9.1 | Diagram rendering |
| [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 | PDF export |
| [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | 2.8.1 | Vector SVG-to-PDF conversion |

## Browser Support

Any modern browser with ES2020+ support (Chrome, Firefox, Safari, Edge).
