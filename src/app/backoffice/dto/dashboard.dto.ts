import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { DASHBOARD_GMV_DAYS, DASHBOARD_TOP_SELLERS } from '../constants';

/* Response DTOs for spec 20 §3.2 (decorators describe the OpenAPI shape only). */

/** Seller orders per open status (BO-13); every key is present. */
export class OpenSellerOrderCountsDto {
  @IsInt()
  @Min(0)
  pending_payment!: number;

  @IsInt()
  @Min(0)
  placed!: number;

  @IsInt()
  @Min(0)
  accepted!: number;

  @IsInt()
  @Min(0)
  ready_for_pickup!: number;

  @IsInt()
  @Min(0)
  picked_up!: number;

  @IsInt()
  @Min(0)
  out_for_delivery!: number;

  @IsInt()
  @Min(0)
  delivery_failed!: number;

  @IsInt()
  @Min(0)
  returning_to_seller!: number;
}

export class DashboardOrdersDto {
  @ValidateNested()
  @Type(() => OpenSellerOrderCountsDto)
  byStatus!: OpenSellerOrderCountsDto;

  @IsInt()
  @Min(0)
  placedToday!: number;

  /** Today and the 6 days before (BO-20). */
  @IsInt()
  @Min(0)
  placedLast7Days!: number;
}

export class DashboardGmvDayDto {
  /** Cairo business day. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  day!: string;

  /** Σ subtotals of the seller orders placed that day, except cancelled ones (BO-22). */
  @IsString()
  placed!: string;

  /** Σ subtotals of the seller orders delivered that day (BO-7). */
  @IsString()
  delivered!: string;
}

export class DashboardTopSellerDto {
  @IsUUID()
  sellerId!: string;

  @IsString()
  businessName!: string;

  @IsString()
  deliveredGmv!: string;
}

export class DashboardSellersDto {
  @IsInt()
  @Min(0)
  pendingApproval!: number;
}

export class DashboardSupportDto {
  @IsInt()
  @Min(0)
  open!: number;

  @IsInt()
  @Min(0)
  awaitingAdmin!: number;

  @IsInt()
  @Min(0)
  slaBreached!: number;
}

export class DashboardFinanceDto {
  @IsString()
  codOutstanding!: string;

  @IsString()
  sellerPayable!: string;

  @IsString()
  agentFeePayable!: string;
}

export class DashboardDeliveryDto {
  @IsInt()
  @Min(0)
  awaitingAssignment!: number;

  @IsInt()
  @Min(0)
  outForDelivery!: number;
}

export class DashboardDto {
  /** When the figures were computed: they may be up to the cache TTL old. */
  @IsISO8601()
  generatedAt!: string;

  @ValidateNested()
  @Type(() => DashboardOrdersDto)
  orders!: DashboardOrdersDto;

  /** The last 30 Cairo days, today included, oldest first (BO-20). */
  @IsArray()
  @ArrayMaxSize(DASHBOARD_GMV_DAYS)
  @ValidateNested({ each: true })
  @Type(() => DashboardGmvDayDto)
  gmv!: DashboardGmvDayDto[];

  /** By delivered GMV over the same 30 days, highest first. */
  @IsArray()
  @ArrayMaxSize(DASHBOARD_TOP_SELLERS)
  @ValidateNested({ each: true })
  @Type(() => DashboardTopSellerDto)
  topSellers!: DashboardTopSellerDto[];

  @ValidateNested()
  @Type(() => DashboardSellersDto)
  sellers!: DashboardSellersDto;

  @ValidateNested()
  @Type(() => DashboardSupportDto)
  support!: DashboardSupportDto;

  @ValidateNested()
  @Type(() => DashboardFinanceDto)
  finance!: DashboardFinanceDto;

  @ValidateNested()
  @Type(() => DashboardDeliveryDto)
  delivery!: DashboardDeliveryDto;
}
