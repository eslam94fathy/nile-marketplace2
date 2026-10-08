'use strict';

/**
 * Allowed synchronous module-to-module imports (docs/design/01-architecture.md §2).
 * Key = importing module, value = modules whose index.ts it may import.
 * A module not listed here may import no other module.
 *
 * Pending: A-2 (00-overview.md §8.2) adds customers → identity, sellers → identity,
 * cart → sellers, finance → sellers + delivery. Add them only once A-2 is approved.
 */
const MODULE_GRAPH = {
  catalog: ['sellers', 'inventory'],
  cart: ['catalog', 'inventory'],
  ordering: ['customers', 'cart', 'catalog', 'sellers', 'inventory', 'payments', 'delivery'],
  delivery: ['identity'],
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
