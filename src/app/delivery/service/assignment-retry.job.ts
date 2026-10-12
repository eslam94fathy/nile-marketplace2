import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type ShipmentRepository } from '../repository/shipment.repository';
import { type ShipmentAssignmentService } from './shipment-assignment.service';

/**
 * `shipment-assignment-retry` (spec 11 UC-DE-1, DE-9): `unassigned` shipments, oldest first, read
 * without locks, each tried in its own short transaction that skips a shipment another transaction
 * holds. A failing shipment is logged and doesn't stop the batch.
 */
@injectable()
export class AssignmentRetryJob {
  constructor(
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.ShipmentAssignmentService) private readonly assignment: ShipmentAssignmentService,
  ) {}

  /** Returns the number of shipments assigned. */
  async run(batchSize: number): Promise<number> {
    let assigned = 0;
    for (const shipmentId of await this.shipments.findUnassignedIds(batchSize)) {
      try {
        if (await this.assignment.retry(shipmentId)) assigned += 1;
      } catch (error) {
        this.logger.error('shipment assignment retry failed', {
          event: 'JOB_SHIPMENT_FAILED',
          shipmentId,
          error,
        });
      }
    }
    return assigned;
  }
}
