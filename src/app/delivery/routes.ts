import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { DELIVERY_ADMIN_PATHS as A, DELIVERY_PATHS as P } from './constants';
import { type DeliverySettingsController } from './controller/delivery-settings.controller';
import { type GovernorateController } from './controller/governorate.controller';
import { UpdateDeliverySettingsDto, UpdateGovernorateDto } from './dto/delivery-request.dto';
import { DeliverySettingsDto, GovernorateDto } from './dto/delivery-response.dto';

const TAGS = ['delivery'] as const;
const ADMIN_TAGS = ['admin: delivery'] as const;

export interface DeliveryRouteDeps {
  governorates: GovernorateController;
  settings: DeliverySettingsController;
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
