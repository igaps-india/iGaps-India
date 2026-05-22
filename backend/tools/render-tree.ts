#!/usr/bin/env tsx
/**
 * tools/render-tree.ts
 *
 * Reads backend/src/seed/tree.yaml and emits:
 *   - docs/tree.mermaid.md  — top-2-level Mermaid diagram (good for PRs, docs)
 *   - docs/tree.dot         — full Graphviz DOT (render with: dot -Tsvg docs/tree.dot -o docs/tree.svg)
 *
 * Usage:
 *   npx tsx tools/render-tree.ts
 *   npx tsx tools/render-tree.ts --depth 3        (expand to layer depth 3)
 *   npx tsx tools/render-tree.ts --mermaid-only
 *   npx tsx tools/render-tree.ts --dot-only
 *
 * Zero runtime dependencies beyond js-yaml (already in backend/node_modules).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

const ROOT = join(__dirname, '..');
const TREE_YAML = join(ROOT, 'src', 'seed', 'tree.yaml');
const DOCS_DIR = join(ROOT, '..', 'docs');

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const maxDepth = (() => {
  const di = args.indexOf('--depth');
  return di !== -1 ? parseInt(args[di + 1], 10) : 2;
})();
const mermaidOnly = args.includes('--mermaid-only');
const dotOnly = args.includes('--dot-only');

// ── Load YAML ─────────────────────────────────────────────────────────────────
interface TreeNode {
  nodeId: string;
  kind: string;
  parentId?: string;
  name: string;
  category: string;
  weight: number;
  enabled: boolean;
  order: number;
}

interface TreeYaml {
  version: number;
  biasProfile: { name: string; threshold: number };
  nodes: TreeNode[];
}

const tree = yaml.load(readFileSync(TREE_YAML, 'utf-8')) as TreeYaml;
const nodes = tree.nodes.filter((n) => n.enabled);

// Depth map: track=1, layer=2, signal=3
function depth(node: TreeNode): number {
  if (node.kind === 'track') return 1;
  if (node.kind === 'layer') return 2;
  return 3;
}

// ── Mermaid output ────────────────────────────────────────────────────────────
function buildMermaid(): string {
  const lines: string[] = [
    '```mermaid',
    'flowchart TD',
    `  ROOT["iGaps Evaluation Tree v${tree.version}\\nPass threshold: ${tree.biasProfile.threshold}%"]`,
  ];

  const shownNodes = nodes.filter((n) => depth(n) <= maxDepth);

  for (const node of shownNodes) {
    const safe = node.nodeId.replace(/\./g, '_');
    const label = `${node.name}\\n[${node.category}] ${node.weight}%`;
    lines.push(`  ${safe}["${label}"]`);
  }

  // Edges
  // Track to root
  for (const node of shownNodes.filter((n) => n.kind === 'track')) {
    const safe = node.nodeId.replace(/\./g, '_');
    lines.push(`  ROOT --> ${safe}`);
  }
  // Layer/signal to parent
  for (const node of shownNodes.filter((n) => n.parentId)) {
    const safe = node.nodeId.replace(/\./g, '_');
    const parentSafe = node.parentId!.replace(/\./g, '_');
    // Only draw edge if parent is in shownNodes
    if (shownNodes.find((n) => n.nodeId === node.parentId)) {
      lines.push(`  ${parentSafe} -->|"${node.weight}%"| ${safe}`);
    }
  }

  lines.push('```');
  return lines.join('\n');
}

// ── Graphviz DOT output ───────────────────────────────────────────────────────
function buildDot(): string {
  const CATEGORY_COLORS: Record<string, string> = {
    required: '#fef9c3',
    must_have: '#dcfce7',
    good_to_have: '#dbeafe',
    not_required: '#f3f4f6',
  };

  const lines: string[] = [
    'digraph EvalTree {',
    '  graph [rankdir=LR fontname="Helvetica" bgcolor="white" label="iGaps Evaluation Tree" labelloc=t fontsize=14]',
    '  node [shape=box style="rounded,filled" fontname="Helvetica" fontsize=10]',
    '  edge [fontname="Helvetica" fontsize=9]',
    '',
    '  ROOT [label="iGaps Evaluation\\nPass ≥ ' + tree.biasProfile.threshold + '%" shape=diamond style=filled fillcolor="#6366f1" fontcolor=white]',
  ];

  for (const node of nodes) {
    const safe = 'N_' + node.nodeId.replace(/[^a-zA-Z0-9]/g, '_');
    const fillcolor = CATEGORY_COLORS[node.category] ?? '#fff';
    const shape = node.kind === 'track' ? 'box' : node.kind === 'layer' ? 'box' : 'ellipse';
    const fontSize = node.kind === 'track' ? 12 : node.kind === 'layer' ? 10 : 9;
    const label = `${node.name}\\n[${node.category}] ${node.weight}%\\n${node.nodeId}`;
    lines.push(
      `  ${safe} [label="${label}" shape=${shape} fillcolor="${fillcolor}" fontsize=${fontSize}]`,
    );
  }

  lines.push('');

  // Edges
  for (const node of nodes.filter((n) => n.kind === 'track')) {
    const safe = 'N_' + node.nodeId.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(`  ROOT -> ${safe} [label="${node.weight}%" penwidth=2]`);
  }
  for (const node of nodes.filter((n) => n.parentId)) {
    const safe = 'N_' + node.nodeId.replace(/[^a-zA-Z0-9]/g, '_');
    const parentSafe = 'N_' + node.parentId!.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(`  ${parentSafe} -> ${safe} [label="${node.weight}%"]`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ── Write outputs ─────────────────────────────────────────────────────────────
mkdirSync(DOCS_DIR, { recursive: true });

if (!dotOnly) {
  const mermaid = buildMermaid();
  const mermaidPath = join(DOCS_DIR, 'tree.mermaid.md');
  writeFileSync(
    mermaidPath,
    `# iGaps Evaluation Tree (Mermaid — top ${maxDepth} levels)\n\nGenerated: ${new Date().toISOString()}\n\n${mermaid}\n`,
  );
  console.log(`[render-tree] Wrote ${mermaidPath}`);
}

if (!mermaidOnly) {
  const dot = buildDot();
  const dotPath = join(DOCS_DIR, 'tree.dot');
  writeFileSync(dotPath, dot);
  console.log(`[render-tree] Wrote ${dotPath}`);
  console.log(`[render-tree] To render SVG: dot -Tsvg docs/tree.dot -o docs/tree.svg`);
  console.log(`[render-tree] To render PNG: dot -Tpng docs/tree.dot -o docs/tree.png`);
}
