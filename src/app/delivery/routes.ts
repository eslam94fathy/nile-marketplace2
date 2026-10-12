import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { AGENT_PATHS as AG, DELIVERY_ADMIN_PATHS as A, DELIVERY_PATHS as P } from './constants';
import { type AgentAdminController, type AgentSelfController } from './controller/delivery-agent.controller';
import { type ShipmentAdminController } from './controller/shipment-admin.controller';
import { AdminShipmentDto, AssignShipmentDto } from './dto/shipment.dto';
import { type DeliverySettingsController } from './controller/delivery-settings.controller';
import { type GovernorateController } from './controller/governorate.controller';
import { UpdateDeliverySettingsDto, UpdateGovernorateDto } from './dto/delivery-request.dto';
import { DeliverySettingsDto, GovernorateDto } from './dto/delivery-response.dto';
import {
  AdminAgentDto,
  AgentProfileDto,
  AvailabilityDto,
  CreateAgentDto,
  UpdateAgentDto,
} from './dto/delivery-agent.dto';

const TAGS = ['delivery'] as const;
const ADMIN_TAGS = ['admin: delivery'] as const;

export interface DeliveryRouteDeps {
  governorates: GovernorateController;
  settings: DeliverySettingsController;
  agentSelf: AgentSelfController;
  agentAdmin: AgentAdminController;
  shipmentAdmin: ShipmentAdminController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 11 §4.1 (public) and the reference-data part of §4.3 (admin). General rate limit (global). */
export function deliveryRoutes(deps: DeliveryRouteDeps): Router {
  const { governorates, settings, docs, basePath } = deps;
  const router = Router();
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(P.GOVERNORATES, governorates.list);
  router.get(A.GOVERNORATES, ...adminOnly, governorates.list);
  router.patch(A.GOVERNORATE, ...adminOnly, governorates.updateFee);
  router.get(A.SETTINGS, ...adminOnly, settings.get);
  router.put(A.SETTINGS, ...adminOnly, settings.update);

  const agentOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.DELIVERY_AGENT)];
  router.get(AG.PROFILE, ...agentOnly, deps.agentSelf.profile);
  router.patch(AG.AVAILABILITY, ...agentOnly, deps.agentSelf.availability);
  router.post(A.AGENTS, ...adminOnly, deps.agentAdmin.create);
  router.get(A.AGENTS, ...adminOnly, deps.agentAdmin.list);
  router.get(A.AGENT, ...adminOnly, deps.agentAdmin.get);
  router.patch(A.AGENT, ...adminOnly, deps.agentAdmin.update);
  router.post(A.AGENT_DEACTIVATE, ...adminOnly, deps.agentAdmin.deactivate);
  router.post(A.AGENT_ACTIVATE, ...adminOnly, deps.agentAdmin.activate);
  documentAgentRoutes(docs, basePath);

  router.get(A.SHIPMENTS, ...adminOnly, deps.shipmentAdmin.list);
  router.get(A.SHIPMENT, ...adminOnly, deps.shipmentAdmin.get);
  router.post(A.SHIPMENT_ASSIGN, ...adminOnly, deps.shipmentAdmin.assign);
  documentShipmentAdminRoutes(docs, basePath);

  const governorateList = {
    200: { description: 'All 27 governorates, ordered by name', body: GovernorateDto, isArray: true },
  };
  const settingsBody = { 200: { description: 'The delivery settings', body: DeliverySettingsDto } };

  docs.add({
    method: 'get',
    path: `${basePath}${P.GOVERNORATES}`,
    summary: 'Governorates with their delivery fee; a null fee means not deliverable',
    tags: TAGS,
    auth: false,
    responses: governorateList,
  });
  const admin = { tags: ADMIN_TAGS, auth: true } as const;
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.GOVERNORATES}`,
    summary: 'Governorates with their delivery fee (same as the public list)',
    responses: governorateList,
  });
  docs.add({
    ...admin,
    method: 'patch',
    path: `${basePath}${A.GOVERNORATE}`,
    summary:
      'Set the delivery fee, or null to stop delivering there; new checkouts only (GOVERNORATE_NOT_FOUND)',
    requestBody: UpdateGovernorateDto,
    responses: { 200: { description: 'The governorate after the change', body: GovernorateDto } },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.SETTINGS}`,
    summary: "The agents' share of the delivery fee",
    responses: settingsBody,
  });
  docs.add({
    ...admin,
    method: 'put',
    path: `${basePath}${A.SETTINGS}`,
    summary: "Change the agents' share of the delivery fee; new checkouts only",
    requestBody: UpdateDeliverySettingsDto,
    responses: settingsBody,
  });

  return router;
}

/** OpenAPI for spec 11 §4.2 (agent profile, availability) and the agent part of §4.3. */
function documentAgentRoutes(docs: OpenApiRegistry, basePath: string): void {
  const agent = { tags: ['agent'], auth: true } as const;
  docs.add({
    ...agent,
    method: 'get',
    path: `${basePath}${AG.PROFILE}`,
    summary: 'My agent profile, in any status (an inactive agent sees its state here)',
    responses: { 200: { description: 'My profile', body: AgentProfileDto } },
  });
  docs.add({
    ...agent,
    method: 'patch',
    path: `${basePath}${AG.AVAILABILITY}`,
    summary:
      'Go on / off shift; off shift keeps current shipments and only stops new assignments (AGENT_INACTIVE 403)',
    requestBody: AvailabilityDto,
    responses: { 200: { description: 'My profile', body: AgentProfileDto } },
  });

  const admin = { tags: ['admin: delivery agents'], auth: true } as const;
  docs.add({
    ...admin,
    method: 'post',
    path: `${basePath}${A.AGENTS}`,
    summary:
      'Create an agent with an invited login; the invite is emailed (EMAIL_ALREADY_REGISTERED 409, GOVERNORATE_NOT_FOUND 422)',
    requestBody: CreateAgentDto,
    responses: { 201: { description: 'The agent', body: AdminAgentDto } },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.AGENTS}`,
    summary:
      'Agents. Filters: status[eq], onShift[eq], homeGovernorateId[eq], fullName[like], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'status[eq]', in: 'query', schema: { enum: ['active', 'inactive'] } },
      { name: 'onShift[eq]', in: 'query', schema: { type: 'boolean' } },
      { name: 'homeGovernorateId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'fullName[like]', in: 'query', schema: { type: 'string' } },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: { description: 'One page of agents', body: AdminAgentDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.AGENT}`,
    summary: 'An agent (AGENT_NOT_FOUND)',
    responses: { 200: { description: 'The agent', body: AdminAgentDto } },
  });
  docs.add({
    ...admin,
    method: 'patch',
    path: `${basePath}${A.AGENT}`,
    summary: 'Change name, phone or home governorate (AGENT_NOT_FOUND, GOVERNORATE_NOT_FOUND 422)',
    requestBody: UpdateAgentDto,
    responses: { 200: { description: 'The agent', body: AdminAgentDto } },
  });
  docs.add({
    ...admin,
    method: 'post',
    path: `${basePath}${A.AGENT_DEACTIVATE}`,
    summary:
      'Deactivate: off shift, no new work, an active login suspended (AGENT_NOT_FOUND, AGENT_HAS_ACTIVE_SHIPMENTS 409, AGENT_INVALID_STATUS_TRANSITION 409)',
    responses: { 200: { description: 'The agent', body: AdminAgentDto } },
  });
  docs.add({
    ...admin,
    method: 'post',
    path: `${basePath}${A.AGENT_ACTIVATE}`,
    summary:
      'Activate again; a suspended login is reactivated (AGENT_NOT_FOUND, AGENT_INVALID_STATUS_TRANSITION 409)',
    responses: { 200: { description: 'The agent', body: AdminAgentDto } },
  });
}

/** OpenAPI for the shipment part of spec 11 §4.3. */
function documentShipmentAdminRoutes(docs: OpenApiRegistry, basePath: string): void {
  const admin = { tags: ['admin: shipments'], auth: true } as const;
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.SHIPMENTS}`,
    summary:
      'Shipments. Filters: status[eq|in], agentId[eq], orderId[eq], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'status[eq]', in: 'query', schema: { type: 'string' } },
      { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'agentId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'orderId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: {
        description: 'One page of shipments (no history)',
        body: AdminShipmentDto,
        isArray: true,
        paginated: true,
      },
    },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.SHIPMENT}`,
    summary: 'A shipment with its attempts and status history (SHIPMENT_NOT_FOUND)',
    responses: { 200: { description: 'The shipment', body: AdminShipmentDto } },
  });
  docs.add({
    ...admin,
    method: 'post',
    path: `${basePath}${A.SHIPMENT_ASSIGN}`,
    summary:
      'Assign or reassign before pickup, to any active agent (SHIPMENT_NOT_FOUND 404, AGENT_NOT_FOUND 422, AGENT_INACTIVE 409, SHIPMENT_NOT_ASSIGNABLE 409, SHIPMENT_ALREADY_ASSIGNED_TO_AGENT 409)',
    requestBody: AssignShipmentDto,
    responses: { 200: { description: 'The shipment', body: AdminShipmentDto } },
  });
}
