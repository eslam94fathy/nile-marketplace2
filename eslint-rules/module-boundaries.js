'use strict';

/**
 * Enforces the dependency rules of CLAUDE.md §2.1–§2.2 on relative imports under src/:
 *   - pkg    may import only pkg
 *   - lib    may import pkg and lib
 *   - app/<m> may import pkg, lib, its own files, and another module ONLY via its index.ts,
 *     and only along an edge allowed in module-graph.js
 *   - migrations may import pkg only
 *   - nothing imports migrations, and nothing in app/lib/pkg imports an entrypoint (src/*.ts)
 */
const path = require('node:path');
const { MODULE_GRAPH } = require('./module-graph');

const SRC = path.resolve(__dirname, '..', 'src');

function classify(absPath) {
  const rel = path.relative(SRC, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { layer: 'outside' };
  const parts = rel.split(path.sep);
  const [top, second, third] = parts;
  if (parts.length === 1) return { layer: 'entry' };
  if (top === 'pkg') return { layer: 'pkg' };
  if (top === 'lib') return { layer: 'lib' };
  if (top === 'migrations') return { layer: 'migrations' };
  if (top === 'app') {
    const isIndex = parts.length === 2 || (parts.length === 3 && /^index(\.[cm]?[jt]s)?$/.test(third ?? ''));
    return { layer: 'app', module: second, isIndex };
  }
  return { layer: 'other' };
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce app → lib → pkg layering and module public APIs' },
    schema: [],
    messages: {
      layer: '{{from}} must not import {{to}} (CLAUDE.md §2.1: app → lib → pkg).',
      privateModule:
        "Module '{{from}}' may import module '{{to}}' only through its index.ts (CLAUDE.md §2.2).",
      edge: "Module '{{from}}' is not allowed to depend on module '{{to}}' (eslint-rules/module-graph.js).",
      migrations: 'Nothing may import migrations.',
    },
  },
  create(context) {
    const filename = context.filename;
    const from = classify(filename);
    if (from.layer === 'outside') return {};

    function check(node, source) {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const to = classify(path.resolve(path.dirname(filename), source));
      if (to.layer === 'outside' || to.layer === 'other') return;

      if (to.layer === 'migrations' && from.layer !== 'migrations' && from.layer !== 'entry') {
        context.report({ node, messageId: 'migrations' });
        return;
      }
      const deny = (messageId, data) => context.report({ node, messageId, data });
      const toName = to.layer === 'app' ? `app/${to.module}` : to.layer;

      switch (from.layer) {
        case 'pkg':
          if (to.layer !== 'pkg') deny('layer', { from: 'pkg', to: toName });
          return;
        case 'lib':
          if (to.layer !== 'pkg' && to.layer !== 'lib') deny('layer', { from: 'lib', to: toName });
          return;
        case 'migrations':
          if (to.layer !== 'pkg' && to.layer !== 'migrations')
            deny('layer', { from: 'migrations', to: toName });
          return;
        case 'app':
          if (to.layer === 'entry') return deny('layer', { from: `app/${from.module}`, to: 'an entrypoint' });
          if (to.layer !== 'app' || to.module === from.module) return;
          if (!to.isIndex) return deny('privateModule', { from: from.module, to: to.module });
          if (!(MODULE_GRAPH[from.module] ?? []).includes(to.module)) {
            deny('edge', { from: from.module, to: to.module });
          }
          return;
        case 'entry':
          if (to.layer === 'app' && !to.isIndex) {
            deny('privateModule', { from: 'entrypoint', to: to.module });
          }
          return;
        default:
          return;
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && check(node.source, node.source.value),
    };
  },
};
