import { type ErrorDetail } from '../../../lib/error';
import { sha256Hex } from '../../../pkg/crypto';
import { type CategoryAttribute, type CategoryAttributeOption } from './category-tree.model';

export interface ResolvedVariantOptions {
  values: { attributeId: string; optionId: string }[];
  /** SHA-256 (hex) of the sorted option ids joined by ","; of "" for the default variant. */
  signature: string;
}

const FIELD = 'optionIds';

export function optionSignature(optionIds: readonly string[]): string {
  return sha256Hex([...optionIds].sort().join(','));
}

/**
 * A variant picks exactly one option for each effective attribute of its product's category
 * (SD-7, spec 06 UC-CA-4). `found` are the options that exist among `requestedIds`.
 * Returns the values to store, or every problem at once.
 */
export function resolveVariantOptions(
  effective: readonly CategoryAttribute[],
  requestedIds: readonly string[],
  found: readonly CategoryAttributeOption[],
): ResolvedVariantOptions | ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const byId = new Map(found.map((option) => [option.id, option]));
  const effectiveIds = new Set(effective.map((attribute) => attribute.id));
  const chosen = new Map<string, string>();

  for (const id of requestedIds) {
    const option = byId.get(id);
    if (!option) {
      problems.push({ field: FIELD, constraint: 'unknown', message: 'option does not exist', value: id });
    } else if (!effectiveIds.has(option.attributeId)) {
      problems.push({
        field: FIELD,
        constraint: 'not_applicable',
        message: "option belongs to an attribute outside this product's category",
        value: id,
      });
    } else if (chosen.has(option.attributeId)) {
      problems.push({
        field: FIELD,
        constraint: 'one_per_attribute',
        message: 'more than one option for the same attribute',
        value: id,
      });
    } else {
      chosen.set(option.attributeId, id);
    }
  }
  // A bad option id would also show up as its attribute "missing": report those only on a clean list.
  const optionsValid = problems.length === 0;
  for (const attribute of effective) {
    if (optionsValid && !chosen.has(attribute.id)) {
      problems.push({
        field: FIELD,
        constraint: 'missing',
        message: `an option for "${attribute.code}" is required`,
        value: attribute.code,
      });
    }
  }
  if (problems.length > 0) return problems;
  return {
    values: [...chosen].map(([attributeId, optionId]) => ({ attributeId, optionId })),
    signature: optionSignature(requestedIds),
  };
}
