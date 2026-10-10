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
  MessageBroker: Symbol.for('MessageBroker'),
  Outbox: Symbol.for('Outbox'),
  SecretBox: Symbol.for('SecretBox'),
  JwtSigner: Symbol.for('JwtSigner'),
  PasswordHasher: Symbol.for('PasswordHasher'),
  EmailSender: Symbol.for('EmailSender'),
  JwtVerifier: Symbol.for('JwtVerifier'),
  RateLimiters: Symbol.for('RateLimiters'),
  OpenApiRegistry: Symbol.for('OpenApiRegistry'),

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
  CustomerController: Symbol.for('CustomerController'),
  CustomerAddressController: Symbol.for('CustomerAddressController'),

  // sellers module
  SellerRepository: Symbol.for('SellerRepository'),
  SellerStatusHistoryRepository: Symbol.for('SellerStatusHistoryRepository'),
  SellerSettingsRepository: Symbol.for('SellerSettingsRepository'),
  SellerService: Symbol.for('SellerService'),
  /** Public API of sellers (spec 05 §2), injected into other modules. */
  SellerDirectory: Symbol.for('SellerDirectory'),
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
  /** Public API of inventory (spec 07 §2), injected into other modules. */
  InventoryService: Symbol.for('InventoryService'),

  // notifications module
  NotificationLogRepository: Symbol.for('NotificationLogRepository'),
  EmailNotificationService: Symbol.for('EmailNotificationService'),

  // health module
  HealthService: Symbol.for('HealthService'),
  HealthController: Symbol.for('HealthController'),
} as const;
