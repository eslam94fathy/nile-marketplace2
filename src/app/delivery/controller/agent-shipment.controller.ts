import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { Money } from '../../../lib/money';
import {
  AGENT_SHIPMENT_LIST_SPEC,
  DeliveredDto,
  FailedAttemptDto,
  ShipmentIdParamsDto,
  toAgentShipmentDto,
} from '../dto/shipment.dto';
import { type DeliveryAgent } from '../model/delivery-agent.model';
import { type Shipment } from '../model/shipment.model';
import { type DeliveryAgentService } from '../service/delivery-agent.service';
import { type ShipmentViewService } from '../service/shipment-view.service';
import { type ShipmentWorkService } from '../service/shipment-work.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 11 §4.2 shipments). Routes are agent-guarded; every call needs an active agent (DE-5). */
@injectable()
export class AgentShipmentController {
  constructor(
    @inject(TOKENS.DeliveryAgentService) private readonly agents: DeliveryAgentService,
    @inject(TOKENS.ShipmentViewService) private readonly views: ShipmentViewService,
    @inject(TOKENS.ShipmentWorkService) private readonly work: ShipmentWorkService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const agent = await this.agentOf(req);
    const query = parseListQuery(req.query, AGENT_SHIPMENT_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.listForAgent(agent.id, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAgentShipmentDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    const agent = await this.agentOf(req);
    sendSuccess(res, HTTP_STATUS.OK, toAgentShipmentDto(await this.views.getForAgent(agent.id, shipmentId)));
  };

  pickedUp = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    await this.respond(res, await this.work.pickedUp(await this.agentOf(req), shipmentId));
  };

  outForDelivery = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    await this.respond(res, await this.work.outForDelivery(await this.agentOf(req), shipmentId));
  };

  delivered = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    const { codCollectedAmount } = await validateDto(DeliveredDto, req.body ?? {});
    const given = codCollectedAmount === undefined ? undefined : Money.of(codCollectedAmount);
    await this.respond(res, await this.work.delivered(await this.agentOf(req), shipmentId, given));
  };

  failedAttempt = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    const { reason, note } = await validateDto(FailedAttemptDto, req.body);
    const agent = await this.agentOf(req);
    await this.respond(res, await this.work.failedAttempt(agent, shipmentId, reason, note ?? null));
  };

  returned = async (req: Request, res: Response): Promise<void> => {
    const { shipmentId } = await validateDto(ShipmentIdParamsDto, req.params);
    await this.respond(res, await this.work.returned(await this.agentOf(req), shipmentId));
  };

  private async agentOf(req: Request): Promise<DeliveryAgent> {
    if (!req.auth) throw unauthenticated();
    return this.agents.activeAgentOfUser(req.auth.userId);
  }

  private async respond(res: Response, shipment: Shipment): Promise<void> {
    sendSuccess(res, HTTP_STATUS.OK, toAgentShipmentDto(await this.views.viewOf(shipment)));
  }
}
