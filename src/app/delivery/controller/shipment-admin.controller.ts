import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import {
  ADMIN_SHIPMENT_LIST_SPEC,
  AssignShipmentDto,
  ShipmentIdParamsDto,
  toAdminShipmentDto,
} from '../dto/shipment.dto';
import { type ShipmentAssignmentService } from '../service/shipment-assignment.service';
import { type ShipmentViewService } from '../service/shipment-view.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 11 §4.3 shipments). Routes are admin-guarded. */
@injectable()
export class ShipmentAdminController {
  constructor(
    @inject(TOKENS.ShipmentViewService) private readonly views: ShipmentViewService,
    @inject(TOKENS.ShipmentAssignmentService) private readonly assignment: ShipmentAssignmentService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_SHIPMENT_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.listForAdmin(query);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      page.items.map((view) => toAdminShipmentDto(view, false)),
      page.meta,
    );
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminShipmentDto(await this.views.get(shipmentId), true));
  };

  assign = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    const { agentId } = await validateDto(AssignShipmentDto, req.body);
    if (!req.auth) throw unauthenticated();
    await this.assignment.adminAssign(shipmentId, agentId, req.auth.userId);
    sendSuccess(res, HTTP_STATUS.OK, toAdminShipmentDto(await this.views.get(shipmentId), true));
  };
}
