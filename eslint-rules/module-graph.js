'use strict';

/**
 * Allowed synchronous module-to-module imports (docs/design/01-architecture.md §2).
 * Key = importing module, value = modules whose index.ts it may import.
 * A module not listed here may import no other module. Includes A-2 (architecture v1.3), A-4 (v1.6) and the R2 edges of v2.0 §14.2, added phase by phase.
 */
const MODULE_GRAPH = {
  // R2-P4 (spec 04 §8.1): wishlist product cards.
  customers: ['identity', 'catalog'],
  sellers: ['identity'],
  delivery: ['identity'],
  catalog: ['sellers', 'inventory', 'media'],
  cart: ['catalog', 'customers', 'inventory', 'sellers', 'media'],
  ordering: ['customers', 'cart', 'catalog', 'sellers', 'inventory', 'payments', 'delivery', 'media'],
  finance: ['sellers', 'delivery'],
  // R2-P2 (spec 15): profiles at connect, parties and statuses for the fan-out; R2-P3: support (canView).
  realtime: ['customers', 'sellers', 'delivery', 'ordering', 'support'],
  // R2-P2 (spec 13 §8, spec 02 §6.3): recipient resolution.
  notifications: ['customers', 'sellers', 'delivery', 'ordering'],
  // R2-P3 (spec 16): order links, opener names, assignees and admin emails, attachments.
  support: ['ordering', 'customers', 'sellers', 'identity', 'media'],
  // R2-P4 (spec 17): reviewable items, product cards, reviewer names, the seller guard, review images.
  reviews: ['ordering', 'catalog', 'customers', 'sellers', 'media'],
  // R2 (architecture v2.0 §14.2). Modules record audit rows through lib/audit, not by importing audit.
  audit: ['identity'],
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
