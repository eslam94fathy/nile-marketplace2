export const DELIVERY_TABLES = {
  GOVERNORATES: 'governorates',
  DELIVERY_SETTINGS: 'delivery_settings',
  DELIVERY_AGENTS: 'delivery_agents',
  SHIPMENTS: 'shipments',
  SHIPMENT_ATTEMPTS: 'shipment_attempts',
  SHIPMENT_STATUS_HISTORY: 'shipment_status_history',
} as const;

/** Paths under /api/v1 (spec 11 §4). */
export const DELIVERY_PATHS = {
  GOVERNORATES: '/governorates',
} as const;

/** The agent's own endpoints (spec 11 §4.2). */
export const AGENT_PATHS = {
  PROFILE: '/agent/profile',
  AVAILABILITY: '/agent/availability',
} as const;

export const DELIVERY_ADMIN_PATHS = {
  GOVERNORATES: '/admin/governorates',
  GOVERNORATE: '/admin/governorates/:governorateId',
  SETTINGS: '/admin/settings/delivery',
  AGENTS: '/admin/delivery-agents',
  AGENT: '/admin/delivery-agents/:agentId',
  AGENT_DEACTIVATE: '/admin/delivery-agents/:agentId/deactivate',
  AGENT_ACTIVATE: '/admin/delivery-agents/:agentId/activate',
  SHIPMENTS: '/admin/shipments',
  SHIPMENT: '/admin/shipments/:shipmentId',
  SHIPMENT_ASSIGN: '/admin/shipments/:shipmentId/assign',
} as const;

/** Queue of the seller-order consumer (docs/spec/02-events.md §2). */
export const SELLER_ORDER_UPDATES_QUEUE = 'delivery.seller-order-updates';

/** The whole governorate list, cache-aside (architecture §8, spec 11 DE-3). */
export const GOVERNORATES_CACHE_KEY = 'v1:delivery:governorates';
