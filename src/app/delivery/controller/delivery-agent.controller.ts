import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import {
  ADMIN_AGENT_LIST_SPEC,
  AgentIdParamsDto,
  AvailabilityDto,
  CreateAgentDto,
  toAdminAgentDto,
  toAgentProfileDto,
  UpdateAgentDto,
} from '../dto/delivery-agent.dto';
import { type DeliveryAgentService } from '../service/delivery-agent.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}

/** HTTP only (spec 11 §4.2): the caller's own agent profile. */
@injectable()
export class AgentSelfController {
  constructor(@inject(TOKENS.DeliveryAgentService) private readonly agents: DeliveryAgentService) {}

  /** Any agent status: the app shows a deactivated agent its state (DE-5). */
  profile = async (req: Request, res: Response): Promise<void> => {
    const agent = await this.agents.agentOfUser(userIdOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAgentProfileDto(await this.agents.viewOf(agent)));
  };

  availability = async (req: Request, res: Response): Promise<void> => {
    const { onShift } = await validateDto(AvailabilityDto, req.body);
    const agent = await this.agents.activeAgentOfUser(userIdOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAgentProfileDto(await this.agents.setAvailability(agent, onShift)));
  };
}

/** HTTP only (spec 11 §4.3). Routes are admin-guarded. */
@injectable()
export class AgentAdminController {
  constructor(
    @inject(TOKENS.DeliveryAgentService) private readonly agents: DeliveryAgentService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const input = await validateDto(CreateAgentDto, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, toAdminAgentDto(await this.agents.create(input)));
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_AGENT_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.agents.list(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminAgentDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { agentId } = await validateDto(AgentIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminAgentDto(await this.agents.get(agentId)));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { agentId } = await validateDto(AgentIdParamsDto, req.params);
    const { fullName, phone, homeGovernorateId } = await validateDto(UpdateAgentDto, req.body);
    const view = await this.agents.update(agentId, {
      ...(fullName !== undefined ? { fullName } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(homeGovernorateId !== undefined ? { homeGovernorateId } : {}),
    });
    sendSuccess(res, HTTP_STATUS.OK, toAdminAgentDto(view));
  };

  deactivate = async (req: Request, res: Response): Promise<void> => {
    const { agentId } = await validateDto(AgentIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminAgentDto(await this.agents.deactivate(agentId, userIdOf(req))));
  };

  activate = async (req: Request, res: Response): Promise<void> => {
    const { agentId } = await validateDto(AgentIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminAgentDto(await this.agents.activate(agentId, userIdOf(req))));
  };
}
