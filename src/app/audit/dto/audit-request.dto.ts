import { AUDIT_ACTION_NAMES, AuditTargetType } from '../../../lib/audit';
import { FieldType, FilterOp, type ListSpec, UuidField } from '../../../lib/http';

export class AuditEntryIdParamsDto {
  @UuidField()
  entryId!: string;
}

/** Spec 20 §2.5 whitelist for `GET /admin/audit-log`. `targetId` needs `targetType` (checked in the controller). */
export const AUDIT_LOG_LIST_SPEC: ListSpec = {
  fields: {
    actorUserId: { column: 'actor_user_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    action: {
      column: 'action',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: AUDIT_ACTION_NAMES,
    },
    targetType: {
      column: 'target_type',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(AuditTargetType),
    },
    targetId: { column: 'target_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: '-createdAt',
};
