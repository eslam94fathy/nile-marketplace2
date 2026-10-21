/**
 * DI tokens (CLAUDE.md §3). Infrastructure is injected through interfaces, so tests can replace it.
 * Modules add their own tokens in their phase (e.g. `IdentityService`).
 */
export const TOKENS = {
  Env: Symbol.for('Env'),
  Logger: Symbol.for('Logger'),
  Clock: Symbol.for('Clock'),
  Database: Symbol.for('Database'),
  TransactionRunner: Symbol.for('TransactionRunner'),
  PgErrorMapper: Symbol.for('PgErrorMapper'),
  Cache: Symbol.for('Cache'),
  Redis: Symbol.for('Redis'),
  /** lib/auth ISuspendedUsers (api), infrastructure. */
  SuspendedUsers: Symbol.for('SuspendedUsers'),
  MessageBroker: Symbol.for('MessageBroker'),
  Outbox: Symbol.for('Outbox'),
  SecretBox: Symbol.for('SecretBox'),
  JwtSigner: Symbol.for('JwtSigner'),
  PasswordHasher: Symbol.for('PasswordHasher'),
  EmailSender: Symbol.for('EmailSender'),
  JwtVerifier: Symbol.for('JwtVerifier'),
  RateLimiters: Symbol.for('RateLimiters'),
  OpenApiRegistry: Symbol.for('OpenApiRegistry'),
  /** pkg/storage IObjectStorage, the media bucket (api, worker). */
  ObjectStorage: Symbol.for('ObjectStorage'),
  /** pkg/image IImageProcessor (worker). */
  ImageProcessor: Symbol.for('ImageProcessor'),
  /** lib/audit IAuditRecorder, implemented by the audit module (spec 20 §2.2). */
  AuditRecorder: Symbol.for('AuditRecorder'),

  // identity module
  UserRepository: Symbol.for('UserRepository'),
  RefreshTokenRepository: Symbol.for('RefreshTokenRepository'),
  VerificationCodeRepository: Symbol.for('VerificationCodeRepository'),
  TokenService: Symbol.for('TokenService'),
  VerificationCodeService: Symbol.for('VerificationCodeService'),
  IdentityEmailNotifier: Symbol.for('IdentityEmailNotifier'),
  /** Public API of identity (spec 03 §2), injected into other modules. */
  AccountService: Symbol.for('AccountService'),
  AuthService: Symbol.for('AuthService'),
  AuthController: Symbol.for('AuthController'),
  InvitationService: Symbol.for('InvitationService'),
  UserAdminService: Symbol.for('UserAdminService'),
  AdminController: Symbol.for('AdminController'),

  // customers module
  CustomerRepository: Symbol.for('CustomerRepository'),
  CustomerAddressRepository: Symbol.for('CustomerAddressRepository'),
  CustomerService: Symbol.for('CustomerService'),
  CustomerAddressService: Symbol.for('CustomerAddressService'),
  /** Public API of customers (spec 04 §2), injected into other modules. */
  CustomerDirectory: Symbol.for('CustomerDirectory'),
  WishlistRepository: Symbol.for('WishlistRepository'),
  WishlistService: Symbol.for('WishlistService'),
  WishlistController: Symbol.for('WishlistController'),
  CustomerController: Symbol.for('CustomerController'),
  CustomerAdminService: Symbol.for('CustomerAdminService'),
  CustomerAdminController: Symbol.for('CustomerAdminController'),
  CustomerAddressController: Symbol.for('CustomerAddressController'),

  // sellers module
  SellerRepository: Symbol.for('SellerRepository'),
  SellerStatusHistoryRepository: Symbol.for('SellerStatusHistoryRepository'),
  SellerSettingsRepository: Symbol.for('SellerSettingsRepository'),
  SellerService: Symbol.for('SellerService'),
  /** Public API of sellers (spec 05 §2), injected into other modules. */
  SellerDirectory: Symbol.for('SellerDirectory'),
  SellerRatingProjectionService: Symbol.for('SellerRatingProjectionService'),
  SellerCommissionHistoryRepository: Symbol.for('SellerCommissionHistoryRepository'),
  SellerAdminService: Symbol.for('SellerAdminService'),
  SellerController: Symbol.for('SellerController'),
  SellerAdminController: Symbol.for('SellerAdminController'),

  // delivery module (reference data: governorates, settings)
  GovernorateRepository: Symbol.for('GovernorateRepository'),
  DeliverySettingsRepository: Symbol.for('DeliverySettingsRepository'),
  GovernorateService: Symbol.for('GovernorateService'),
  DeliverySettingsService: Symbol.for('DeliverySettingsService'),
  /** Public API of delivery (spec 11 §2), injected into other modules. */
  DeliveryReferenceService: Symbol.for('DeliveryReferenceService'),
  GovernorateController: Symbol.for('GovernorateController'),
  DeliverySettingsController: Symbol.for('DeliverySettingsController'),
  DeliveryAgentRepository: Symbol.for('DeliveryAgentRepository'),
  DeliveryAgentService: Symbol.for('DeliveryAgentService'),
  /** Public API of delivery for finance (spec 11 §2, DE-11). */
  DeliveryAgentDirectory: Symbol.for('DeliveryAgentDirectory'),
  AgentSelfController: Symbol.for('AgentSelfController'),
  AgentAdminController: Symbol.for('AgentAdminController'),
  ShipmentRepository: Symbol.for('ShipmentRepository'),
  ShipmentHistoryRepository: Symbol.for('ShipmentHistoryRepository'),
  ShipmentAssignmentService: Symbol.for('ShipmentAssignmentService'),
  ShipmentViewService: Symbol.for('ShipmentViewService'),
  ShipmentWorkService: Symbol.for('ShipmentWorkService'),
  AgentShipmentController: Symbol.for('AgentShipmentController'),
  SellerOrderUpdateService: Symbol.for('SellerOrderUpdateService'),
  AssignmentRetryJob: Symbol.for('AssignmentRetryJob'),
  ShipmentAdminController: Symbol.for('ShipmentAdminController'),

  // catalog module
  CategoryRepository: Symbol.for('CategoryRepository'),
  CategoryAttributeRepository: Symbol.for('CategoryAttributeRepository'),
  CategoryAttributeOptionRepository: Symbol.for('CategoryAttributeOptionRepository'),
  ProductRepository: Symbol.for('ProductRepository'),
  VariantAttributeValueRepository: Symbol.for('VariantAttributeValueRepository'),
  CategoryTreeService: Symbol.for('CategoryTreeService'),
  CategoryService: Symbol.for('CategoryService'),
  CategoryAdminService: Symbol.for('CategoryAdminService'),
  CategoryController: Symbol.for('CategoryController'),
  CategoryAdminController: Symbol.for('CategoryAdminController'),
  ProductVariantRepository: Symbol.for('ProductVariantRepository'),
  SellerGuard: Symbol.for('SellerGuard'),
  VariantViewService: Symbol.for('VariantViewService'),
  ProductProjectionService: Symbol.for('ProductProjectionService'),
  SellerProductService: Symbol.for('SellerProductService'),
  ProductBlockService: Symbol.for('ProductBlockService'),
  ProductBlockController: Symbol.for('ProductBlockController'),
  SellerVariantService: Symbol.for('SellerVariantService'),
  SellerProductController: Symbol.for('SellerProductController'),
  SellerVariantController: Symbol.for('SellerVariantController'),
  ProductDetailCache: Symbol.for('ProductDetailCache'),
  ProductBrowseService: Symbol.for('ProductBrowseService'),
  ProductController: Symbol.for('ProductController'),
  /** Public API of catalog (spec 06 §2), injected into other modules. */
  CatalogDirectory: Symbol.for('CatalogDirectory'),
  ListingProjectionService: Symbol.for('ListingProjectionService'),

  // inventory module
  InventoryItemRepository: Symbol.for('InventoryItemRepository'),
  InventoryMovementRepository: Symbol.for('InventoryMovementRepository'),
  InventoryReservationRepository: Symbol.for('InventoryReservationRepository'),
  /** Public API of inventory (spec 07 §2), injected into other modules. */
  InventoryService: Symbol.for('InventoryService'),

  // cart module
  CartRepository: Symbol.for('CartRepository'),
  CartItemRepository: Symbol.for('CartItemRepository'),
  /** Public API of cart (spec 08 §2), injected into ordering. */
  CartDirectory: Symbol.for('CartDirectory'),
  CartService: Symbol.for('CartService'),
  CartViewService: Symbol.for('CartViewService'),
  CartController: Symbol.for('CartController'),

  // ordering module
  OrderRepository: Symbol.for('OrderRepository'),
  SellerOrderRepository: Symbol.for('SellerOrderRepository'),
  OrderItemRepository: Symbol.for('OrderItemRepository'),
  StatusHistoryRepository: Symbol.for('StatusHistoryRepository'),
  OrderItemCancellationRepository: Symbol.for('OrderItemCancellationRepository'),
  OrderLifecycleService: Symbol.for('OrderLifecycleService'),
  OrderActionService: Symbol.for('OrderActionService'),
  AcceptanceTimeoutJob: Symbol.for('AcceptanceTimeoutJob'),
  ShipmentUpdateService: Symbol.for('ShipmentUpdateService'),
  PaymentUpdateService: Symbol.for('PaymentUpdateService'),
  PaymentExpiryJob: Symbol.for('PaymentExpiryJob'),
  CheckoutService: Symbol.for('CheckoutService'),
  OrderViewService: Symbol.for('OrderViewService'),
  OrderingDirectory: Symbol.for('OrderingDirectory'),
  OrderingStatsRepository: Symbol.for('OrderingStatsRepository'),
  FinanceDirectory: Symbol.for('FinanceDirectory'),
  ShipmentDirectory: Symbol.for('ShipmentDirectory'),
  DashboardService: Symbol.for('DashboardService'),
  DashboardController: Symbol.for('DashboardController'),
  AdminOrderActionService: Symbol.for('AdminOrderActionService'),
  RealtimeEmitter: Symbol.for('RealtimeEmitter'),
  RealtimeFanoutService: Symbol.for('RealtimeFanoutService'),
  ProfileRoomsService: Symbol.for('ProfileRoomsService'),
  OrderController: Symbol.for('OrderController'),
  SellerOrderController: Symbol.for('SellerOrderController'),
  AdminOrderController: Symbol.for('AdminOrderController'),

  // payments module
  /** pkg/payments IPaymentGateway (Kashier or the fake), infrastructure. */
  PaymentGateway: Symbol.for('PaymentGateway'),
  PaymentRepository: Symbol.for('PaymentRepository'),
  PaymentRefundRepository: Symbol.for('PaymentRefundRepository'),
  /** Public API of payments (spec 10 §2), injected into ordering. */
  PaymentDirectory: Symbol.for('PaymentDirectory'),
  OrderAdjustmentService: Symbol.for('OrderAdjustmentService'),
  PaymentEventRepository: Symbol.for('PaymentEventRepository'),
  PaymentSettlementService: Symbol.for('PaymentSettlementService'),
  KashierWebhookService: Symbol.for('KashierWebhookService'),
  PaymentAdminService: Symbol.for('PaymentAdminService'),
  PaymentWebhookController: Symbol.for('PaymentWebhookController'),
  PaymentAdminController: Symbol.for('PaymentAdminController'),

  // finance module
  FinanceAccountRepository: Symbol.for('FinanceAccountRepository'),
  LedgerEntryRepository: Symbol.for('LedgerEntryRepository'),
  /** The only writer of balances (spec 12 §1.1). */
  LedgerService: Symbol.for('LedgerService'),
  LedgerBookingService: Symbol.for('LedgerBookingService'),
  CodRemittanceRepository: Symbol.for('CodRemittanceRepository'),
  PayoutRepository: Symbol.for('PayoutRepository'),
  FinanceViewService: Symbol.for('FinanceViewService'),
  CodRemittanceService: Symbol.for('CodRemittanceService'),
  PayoutService: Symbol.for('PayoutService'),
  FinanceAdminController: Symbol.for('FinanceAdminController'),
  SellerFinanceController: Symbol.for('SellerFinanceController'),
  AgentFinanceController: Symbol.for('AgentFinanceController'),

  // notifications module
  NotificationLogRepository: Symbol.for('NotificationLogRepository'),
  EmailNotificationService: Symbol.for('EmailNotificationService'),
  UserNotificationRepository: Symbol.for('UserNotificationRepository'),
  NotificationPreferenceRepository: Symbol.for('NotificationPreferenceRepository'),
  UserEventsService: Symbol.for('UserEventsService'),
  NotificationRetentionJob: Symbol.for('NotificationRetentionJob'),
  NotificationCenterService: Symbol.for('NotificationCenterService'),
  NotificationController: Symbol.for('NotificationController'),
  PushSubscriptionRepository: Symbol.for('PushSubscriptionRepository'),
  PushSubscriptionService: Symbol.for('PushSubscriptionService'),
  PushDeliveryService: Symbol.for('PushDeliveryService'),
  PushSender: Symbol.for('PushSender'),
  PushController: Symbol.for('PushController'),

  // audit module (spec 20 §2)
  AuditLogRepository: Symbol.for('AuditLogRepository'),
  AuditViewService: Symbol.for('AuditViewService'),
  AuditRetentionJob: Symbol.for('AuditRetentionJob'),
  AuditController: Symbol.for('AuditController'),

  // catalog images (R2, spec 06 §8)
  ProductImageRepository: Symbol.for('ProductImageRepository'),
  ProductImageViewService: Symbol.for('ProductImageViewService'),
  ProductImageService: Symbol.for('ProductImageService'),
  ProductImageController: Symbol.for('ProductImageController'),

  // media module
  MediaObjectRepository: Symbol.for('MediaObjectRepository'),
  MediaUrls: Symbol.for('MediaUrls'),
  /** Public API of media (spec 14 §2), injected into catalog, support, reviews and returns. */
  MediaService: Symbol.for('MediaService'),
  MediaUploadService: Symbol.for('MediaUploadService'),
  MediaProcessingService: Symbol.for('MediaProcessingService'),
  MediaCleanupJob: Symbol.for('MediaCleanupJob'),
  MediaController: Symbol.for('MediaController'),

  // support module (spec 16)
  SupportTicketRepository: Symbol.for('SupportTicketRepository'),
  SupportMessageRepository: Symbol.for('SupportMessageRepository'),
  SupportAttachmentRepository: Symbol.for('SupportAttachmentRepository'),
  SupportReadRepository: Symbol.for('SupportReadRepository'),
  SupportViewService: Symbol.for('SupportViewService'),
  SupportTicketService: Symbol.for('SupportTicketService'),
  SupportTicketController: Symbol.for('SupportTicketController'),
  SupportTimelineService: Symbol.for('SupportTimelineService'),
  SupportAttachmentService: Symbol.for('SupportAttachmentService'),
  SupportJobs: Symbol.for('SupportJobs'),
  SupportAdminService: Symbol.for('SupportAdminService'),
  SupportAdminController: Symbol.for('SupportAdminController'),
  /** Public API of support (spec 16 §2), read by realtime and the back-office. */
  SupportDirectory: Symbol.for('SupportDirectory'),

  // reviews module (spec 17)
  ProductReviewRepository: Symbol.for('ProductReviewRepository'),
  ReviewImageRepository: Symbol.for('ReviewImageRepository'),
  ReviewReplyRepository: Symbol.for('ReviewReplyRepository'),
  RatingStatsRepository: Symbol.for('RatingStatsRepository'),
  RatingAggregatesService: Symbol.for('RatingAggregatesService'),
  ReviewService: Symbol.for('ReviewService'),
  ReviewViewService: Symbol.for('ReviewViewService'),
  MyReviewController: Symbol.for('MyReviewController'),
  ReviewModerationService: Symbol.for('ReviewModerationService'),
  PublicReviewController: Symbol.for('PublicReviewController'),
  SellerReviewController: Symbol.for('SellerReviewController'),
  AdminReviewController: Symbol.for('AdminReviewController'),

  // health module
  HealthService: Symbol.for('HealthService'),
  HealthChecks: Symbol.for('HealthChecks'),
  HealthController: Symbol.for('HealthController'),
} as const;
