import type {
  StatsigConfigWrapper,
  StatsigRule,
  TransformError,
  TransformNotice,
} from './types';

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

/**
 * @param configs a list of gates or segments
 * @returns a list of configs ordered by dependencies. if config A depends on config B, then config A will be before config B in the list.
 */
export function sortConfigsFromDependentToIndependent<
  T extends { id: string; rules: StatsigRule[] },
>(configs: T[], configType: 'gate' | 'segment'): T[] {
  const configMap = new Map<string, T>(
    configs.map((config) => [config.id, config]),
  );

  // If configA has a rule that contains configB, configB -> configA
  const dependencies = new Map<string, Set<string>>();
  for (const config of configs) {
    dependencies.set(config.id, new Set());
  }

  for (const config of configs) {
    const configId = config.id;

    for (const rule of config.rules) {
      for (const condition of rule.conditions) {
        if (
          (configType === 'gate' &&
            ['passes_gate', 'fails_gate'].includes(condition.type)) ||
          (configType === 'segment' &&
            ['passes_segment', 'fails_segment'].includes(condition.type))
        ) {
          const targetConfig = condition.targetValue as string;
          if (targetConfig && configMap.has(targetConfig)) {
            dependencies.get(targetConfig)?.add(configId);
          }
        }
      }
    }
  }

  const result: T[] = [];
  const remaining = new Set(configs.map((config) => config.id));

  while (remaining.size > 0) {
    let found = false;

    // Find a config that has no remaining dependencies
    for (const configId of remaining) {
      const deps = dependencies.get(configId) || new Set();
      const hasUnresolvedDeps = Array.from(deps).some((dep) =>
        remaining.has(dep),
      );

      if (!hasUnresolvedDeps) {
        const config = configMap.get(configId);
        if (config) {
          result.push(config);
          remaining.delete(configId);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      // This should not happen if there are no circular dependencies
      throw new Error(
        'Circular dependency detected or unable to resolve dependencies',
      );
    }
  }

  return result;
}

export function getConfigID(config: StatsigConfigWrapper): string {
  return config.type === 'gate'
    ? config.gate.id
    : config.type === 'dynamic_config'
      ? config.dynamicConfig.id
      : config.segment.id;
}
