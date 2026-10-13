import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type DeliverySettingsService } from './delivery-settings.service';
import { type GovernorateService } from './governorate.service';

/** What ordering sees of a governorate at checkout (spec 11 §2). */
export interface GovernorateFee {
  id: string;
  name: string;
  /** Money string, or null = not deliverable (Q-26). */
  deliveryFee: string | null;
}

/** Public API of delivery's reference data (spec 11 §2). Agents/shipments methods arrive in P6. */
export interface IDeliveryReferenceService {
  /** Batched, from the cache. Unknown ids are left out. */
  getGovernorateFees(ids: readonly string[]): Promise<GovernorateFee[]>;
  /** Rate string, e.g. "0.7000". */
  getAgentFeeShareRate(): Promise<string>;
}

@injectable()
export class DeliveryReferenceService implements IDeliveryReferenceService {
  constructor(
    @inject(TOKENS.GovernorateService) private readonly governorates: GovernorateService,
    @inject(TOKENS.DeliverySettingsService) private readonly settings: DeliverySettingsService,
  ) {}

  async getGovernorateFees(ids: readonly string[]): Promise<GovernorateFee[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    const all = await this.governorates.list();
    return all
      .filter((governorate) => wanted.has(governorate.id))
      .map((governorate) => ({
        id: governorate.id,
        name: governorate.name,
        deliveryFee: governorate.deliveryFee?.toString() ?? null,
      }));
  }

  async getAgentFeeShareRate(): Promise<string> {
    return (await this.settings.get()).agentFeeShareRate.toString();
  }
}
