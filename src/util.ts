import type { TransformError, TransformNotice } from './types';

export const RETURN_VALUE_WRAP_ATTRIBUTE = 'value';

export function transformErrorToString(error: TransformError): string {
  switch (error.type) {
    case 'fetch_error':
      return `Error fetching flag: ${error.message}`;
    case 'unsupported_flag_kind':
      return `Unsupported flag kind: ${error.flagKind}`;
    case 'unit_id_not_mapped':
      return `Unit ID not mapped for context kind: ${error.contextKind}`;
    case 'custom_attribute_not_mapped':
      return `Custom attribute "${error.attribute}" not mapped for context kind "${error.contextKind}". Use --context-attribute-to-custom-field ${error.contextKind}/${error.attribute}=<custom-field-name> to specify a mapping.`;
    case 'unsupported_pass_percentage':
      return `Unsupported pass percentage`;
    case 'unsupported_operator':
      return `Unsupported operator: ${error.operator}`;
    case 'invalid_clause_values':
      return `Invalid clause values: ${error.operator} with values: ${error.values.join(', ')}`;
    case 'unsupported_off_variation':
      return `Unsupported off variation: ${error.flagKey} in ${error.flagEnvironmentName}`;
    case 'return_value_contains_null':
      return `Return value contains null (which Statsig does not support)`;
    case 'unsupported_segment_type':
      return `Unsupported segment type: ${error.flagKey}`;
    case 'segment_has_exclusions':
      return `Segment has exclusions: ${error.flagKey}`;
    case 'prerequisite_flag_does_not_exist':
      return `Prerequisite flag ${error.prerequisiteFlagKey} does not exist`;
    case 'unsupported_prerequisite_flag_type':
      return `Unsupported prerequisite flag type: ${error.prerequisiteFlagKey} is of type ${error.prerequisiteFlagKind}`;
    default:
      const exhaustive: never = error;
      return exhaustive;
  }
}

export function transformNoticeToString(notice: TransformNotice): string {
  switch (notice.type) {
    case 'return_value_wrapped':
      return `JSON value would be wrapped as { "${RETURN_VALUE_WRAP_ATTRIBUTE}": <value> } as Statsig does not support non-object JSON values`;
    default:
      const exhaustive: never = notice.type;
      return exhaustive;
  }
}

export function jsonContainsNull(obj: unknown): boolean {
  if (obj == null) {
    return true;
  }
  if (Array.isArray(obj)) {
    return obj.findIndex((value) => jsonContainsNull(value)) !== -1;
  }
  if (typeof obj === 'object') {
    return (
      Object.values(obj).findIndex((value) => jsonContainsNull(value)) !== -1
    );
  }
  return false;
}

const MAX_RULE_NAME_LENGTH = 100;

export function capRuleName(ruleName: string): string {
  return ruleName.substring(0, MAX_RULE_NAME_LENGTH);
}
