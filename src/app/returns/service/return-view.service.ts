import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ImageView, type MediaService } from '../../media';
import { type IOrderingDirectory, type IOrderReturns, type OrderItemSnapshot } from '../../ordering';
import { returnNotFound } from '../errors';
import { type ReturnHistoryEntry, type ReturnItem, type ReturnRequest } from '../model/return-request.model';
import { type ReturnHistoryRepository } from '../repository/return-history.repository';
import { type ReturnItemRepository } from '../repository/return-item.repository';
import { type ReturnPhotoRepository } from '../repository/return-photo.repository';
import { type ReturnOwner, type ReturnRequestRepository } from '../repository/return-request.repository';

/** A return item with its order-line snapshot (OR-30) and image. */
export interface ReturnItemView {
  item: ReturnItem;
  snapshot: OrderItemSnapshot;
  image: ImageView | null;
}

/** Everything the customer, seller and admin views show of one request (spec 18 §4). */
export interface ReturnView {
  request: ReturnRequest;
  orderNumber: string;
  items: ReturnItemView[];
  /** Private, presigned (spec 14 ME-1): the caller is already authorised. */
  photos: ImageView[];
  history: ReturnHistoryEntry[];
}

/** Reads for the three audiences; a page costs one query per table plus batched calls (G20). */
@injectable()
export class ReturnViewService {
  constructor(
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.ReturnItemRepository) private readonly items: ReturnItemRepository,
    @inject(TOKENS.ReturnPhotoRepository) private readonly photos: ReturnPhotoRepository,
    @inject(TOKENS.ReturnHistoryRepository) private readonly history: ReturnHistoryRepository,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.OrderReturns) private readonly orderReturns: IOrderReturns,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /** One request of the owner (`{}` = an admin); another party's reads as missing. */
  async get(owner: ReturnOwner, returnId: string): Promise<ReturnView> {
    const request = await this.requests.findById(returnId, owner);
    if (!request) throw returnNotFound();
    return this.viewOf(request);
  }

  async list(owner: ReturnOwner, query: ParsedListQuery): Promise<{ items: ReturnView[]; meta: PageMeta }> {
    const page = toPage(await this.requests.list(owner, query), query, (request) =>
      sortValueOf(request, query),
    );
    return { items: await this.views(page.items), meta: page.meta };
  }

  async viewOf(request: ReturnRequest): Promise<ReturnView> {
    const [view] = await this.views([request]);
    if (!view) throw new Error(`no view built for return ${request.id}`);
    return view;
  }

  async views(requests: readonly ReturnRequest[]): Promise<ReturnView[]> {
    if (requests.length === 0) return [];
    const ids = requests.map((r) => r.id);
    const [items, photos, history, orderNumbers] = await Promise.all([
      this.items.findByReturnIds(ids),
      this.photos.findByReturnIds(ids),
      this.history.findByReturnIds(ids),
      this.ordering.getOrderNumbers(requests.map((r) => r.orderId)),
    ]);
    const snapshots = new Map(
      (await this.orderReturns.getOrderItems(items.map((i) => i.orderItemId))).map((s) => [s.orderItemId, s]),
    );
    const images = await this.media.getImages([
      ...photos.map((p) => p.mediaId),
      ...[...snapshots.values()].flatMap((s) => (s.imageMediaId ? [s.imageMediaId] : [])),
    ]);
    return requests.map((request) => {
      const orderNumber = orderNumbers.get(request.orderId);
      // order_id and order_item_id are RESTRICT FKs: both always exist.
      if (orderNumber === undefined) throw new Error(`return ${request.id} has no order`);
      return {
        request,
        orderNumber,
        items: items
          .filter((item) => item.returnId === request.id)
          .map((item) => {
            const snapshot = snapshots.get(item.orderItemId);
            if (!snapshot) throw new Error(`return item ${item.id} has no order item`);
            return {
              item,
              snapshot,
              image: snapshot.imageMediaId ? (images.get(snapshot.imageMediaId) ?? null) : null,
            };
          }),
        photos: photos
          .filter((photo) => photo.returnId === request.id)
          .flatMap((photo) => images.get(photo.mediaId) ?? []),
        history: history.filter((entry) => entry.returnId === request.id),
      };
    });
  }
}

/** The cursor's sort value follows the requested sort (spec 18 §4.2: the seller's decision queue). */
function sortValueOf(request: ReturnRequest, query: ParsedListQuery): Date {
  return query.sort.field === 'sellerDecisionDeadlineAt' && request.sellerDecisionDeadlineAt
    ? request.sellerDecisionDeadlineAt
    : request.createdAt;
}
