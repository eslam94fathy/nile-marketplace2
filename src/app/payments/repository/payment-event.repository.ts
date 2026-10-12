import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { PAYMENTS_TABLES } from '../constants';
import { type PaymentEventSummary } from '../model/refund.model';

const T = PAYMENTS_TABLES.PAYMENT_EVENTS;

interface PaymentEventTable {
  id: string;
  payment_id: string | null;
  provider: string;
  provider_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  signature_valid: boolean;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The webhook inbox (spec 10 UC-PA-1): only signature-verified webhooks are stored (PA-7). */
@injectable()
export class PaymentEventRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /**
   * Inserts the webhook unless this provider event was seen before
   * (uq_payment_events_provider_provider_event_id). Returns its id, or null for a duplicate.
   */
  async insertIfNew(
    event: {
      provider: string;
      providerEventId: string;
      eventType: string;
      paymentId: string | null;
      payload: Record<string, unknown>;
    },
    trx: DbTransaction,
  ): Promise<string | null> {
    const [row] = await trx<PaymentEventTable>(T)
      .insert({
        payment_id: event.paymentId,
        provider: event.provider,
        provider_event_id: event.providerEventId,
        event_type: event.eventType,
        payload: JSON.stringify(event.payload) as unknown as Record<string, unknown>,
        signature_valid: true,
        processed_at: null,
      })
      .onConflict(['provider', 'provider_event_id'])
      .ignore()
      .returning<Pick<PaymentEventTable, 'id'>[]>('id');
    return row?.id ?? null;
  }

  async markProcessed(id: string, processedAt: Date, trx: DbTransaction): Promise<void> {
    await trx<PaymentEventTable>(T)
      .update({ processed_at: processedAt, updated_at: trx.fn.now() })
      .where({ id });
  }

  /** Events of a payment, oldest first, without payloads: idx_payment_events_payment_id. */
  async listByPaymentId(paymentId: string, trx?: DbTransaction): Promise<PaymentEventSummary[]> {
    const rows = await this.exec(trx)<PaymentEventTable>(T)
      .select('id', 'event_type', 'signature_valid', 'processed_at', 'created_at')
      .where({ payment_id: paymentId })
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      signatureValid: row.signature_valid,
      processedAt: row.processed_at,
      createdAt: row.created_at,
    }));
  }
}
