'use strict';

/**
 * Allowed synchronous module-to-module imports (docs/design/01-architecture.md §2).
 * Key = importing module, value = modules whose index.ts it may import.
 * A module not listed here may import no other module. Includes A-2 (architecture v1.3).
 */
const MODULE_GRAPH = {
  customers: ['identity'],
  sellers: ['identity'],
  delivery: ['identity'],
  catalog: ['sellers', 'inventory'],
  cart: ['catalog', 'inventory', 'sellers'],
  ordering: ['customers', 'cart', 'catalog', 'sellers', 'inventory', 'payments', 'delivery'],
  finance: ['sellers', 'delivery'],
};

/** Throws at lint start-up if the graph has a cycle, so a bad edit can't slip in. */
function assertAcyclic(graph) {
  const state = new Map(); // module -> 'visiting' | 'done'
  const visit = (node, path) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      throw new Error(`module-graph.js has a cycle: ${[...path, node].join(' -> ')}`);
    }
    state.set(node, 'visiting');
    for (const next of graph[node] ?? []) visit(next, [...path, node]);
    state.set(node, 'done');
  };
  for (const node of Object.keys(graph)) visit(node, []);
}

assertAcyclic(MODULE_GRAPH);

module.exports = { MODULE_GRAPH };
