import { IsString } from 'class-validator';
import { FieldType, FilterOp, IsRate, type ListSpec, Optional, StrField, UuidField } from '../../../lib/http';
import { REASON_MAX_LENGTH, REASON_MIN_LENGTH } from '../constants';
import { SellerStatus } from '../enums';

/** Request DTOs for spec 05 §4.4. */

export class SellerIdParamsDto {
  @UuidField()
  sellerId!: string;
}

/** reject, suspend: `reason str(3..500)`. */
export class SellerDecisionDto {
  @StrField(REASON_MIN_LENGTH, REASON_MAX_LENGTH)
  reason!: string;
}

/** reinstate: `reason opt str(3..500)`. */
export class SellerReinstateDto {
  @Optional()
  @StrField(REASON_MIN_LENGTH, REASON_MAX_LENGTH)
  reason?: string;
}

export class SellerCommissionRateDto {
  @IsString()
  @IsRate()
  commissionRate!: string;
}

export class DefaultCommissionDto {
  @IsString()
  @IsRate()
  defaultCommissionRate!: string;
}

/** §4.4 whitelist for `GET /admin/sellers`. */
export const ADMIN_SELLER_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(SellerStatus),
    },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
    businessName: { column: 'business_name', type: FieldType.TEXT, ops: [FilterOp.LIKE] },
    pickupGovernorateId: { column: 'pickup_governorate_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
  },
  defaultSort: '-createdAt',
};
