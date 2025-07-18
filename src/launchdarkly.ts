import type {
  ConfigTransformResult,
  StatsigCondition,
  StatsigConditionType,
  StatsigConfig,
  StatsigDynamicConfigRule,
  StatsigEnvironment,
  StatsigOperatorType,
  StatsigOverride,
  StatsigRule,
  TransformError,
  TransformResult,
} from './types';
import { RETURN_VALUE_WRAP_ATTRIBUTE, jsonContainsNull } from './util';

import { capRuleName } from './util';
import nullthrows from 'nullthrows';

const BASE_URL = 'https://app.launchdarkly.com/api/v2';
const API_VERSION = '20240415';

type Args = {
  apiKey: string;
  projectID: string;
  // Context Kinds are a LaunchDarkly concept that needs to map to Statsig. The
  // user needs to provide the mapping.
  contextKindToUnitIDMapping: Record<string, string>;
  contextCustomAttributeMapping?: Record<string, Record<string, string>>;
  environmentNameMapping: Record<string, string>;
  throttle: <T>(fn: () => Promise<T>) => () => Promise<T>;
};

function getRequestOptions({ apiKey }: { apiKey: string }): RequestInit {
  return {
    headers: {
      Authorization: apiKey,
      'LD-API-Version': API_VERSION,
    },
  };
}

export const launchdarklyApiThrottle = {
  limit: 10,
  interval: 500, //ms
};

export async function getLaunchDarklyConfigs(
  args: Args,
): Promise<ConfigTransformResult> {
  const flagKeysResult = await listFeatureFlagKeys(args);
  if (!flagKeysResult.transformed) {
    return {
      totalConfigCount: undefined,
      validConfigs: [],
      noticesByConfigName: {},
      errorsByConfigName: { '': flagKeysResult.errors },
    };
  }

  const flags = await Promise.all(
    flagKeysResult.result.map((flagKey) => getFeatureFlag(flagKey, args)),
  );

  const configTransformResult: ConfigTransformResult = {
    totalConfigCount: flagKeysResult.result.length,
    validConfigs: [],
    noticesByConfigName: {},
    errorsByConfigName: {},
  };

  flags.forEach((flag) => {
    const transformResult = transformFlagToConfig(
      flag as LaunchDarklyFlag,
      args,
    );
    if (transformResult.transformed) {
      configTransformResult.validConfigs.push(transformResult.result);
      transformResult.notices?.forEach((notice) => {
        configTransformResult.noticesByConfigName[notice.flagKey] =
          configTransformResult.noticesByConfigName[notice.flagKey] || [];
        configTransformResult.noticesByConfigName[notice.flagKey].push(notice);
      });
    } else {
      transformResult.errors.forEach((error) => {
        configTransformResult.errorsByConfigName[error.flagKey] =
          configTransformResult.errorsByConfigName[error.flagKey] || [];
        configTransformResult.errorsByConfigName[error.flagKey].push(error);
      });
    }
  });
  return configTransformResult;
}

async function listFeatureFlagKeys({
  apiKey,
  projectID,
  throttle,
}: Args): Promise<TransformResult<string[]>> {
  const allFlagKeys: string[] = [];
  let nextPage = `${BASE_URL}/flags/${projectID}?summary=0`;
  do {
    try {
      const response = await throttle(() =>
        fetch(
          `${BASE_URL}/flags/${projectID}?summary=0`,
          getRequestOptions({ apiKey }),
        ),
      )();
      if (!response.ok) {
        throw new Error(
          `Failed to list LaunchDarkly flag: ${response.statusText} ${await response.text()}`,
        );
      }
      const data = await response.json();
      allFlagKeys.push(...data.items.map((item: { key: string }) => item.key));
      nextPage = data._links?.next?.href;
    } catch (error) {
      return {
        transformed: false,
        errors: [
          {
            type: 'fetch_error',
            message: error instanceof Error ? error.message : String(error),
            flagKey: '',
          },
        ],
      };
    }
  } while (nextPage);

  return {
    transformed: true,
    result: allFlagKeys,
  };
}

async function getFeatureFlag(
  flagKey: string,
  { apiKey, projectID, throttle }: Args,
): Promise<Object> {
  const response = await throttle(() =>
    fetch(`${BASE_URL}/flags/${projectID}/${flagKey}`, {
      headers: {
        Authorization: `${apiKey}`,
        'LD-API-Version': API_VERSION,
      },
    }),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to fetch LaunchDarkly flag: ${response.statusText} ${await response.text()}`,
    );
  }
  return response.json();
}

type LaunchDarklyFlag = {
  kind: string;
  key: string;
  name: string;
  description: string;
  temporary: boolean;
  tags: string[];
  variations: [
    {
      name: string;
      value: unknown;
    },
  ];
  environments?: Record<
    string,
    {
      on: boolean;
      archived: boolean;
      targets?: {
        values: string[];
        variation: number;
        contextKind?: string;
      }[];
      contextTargets?: {
        values: string[];
        variation: number;
        contextKind?: string;
      }[];
      offVariation?: number;
      rules?: {
        description?: string;
        clauses: {
          attribute: string;
          contextKind?: string;
          op: string;
          values: unknown[];
          negate: boolean;
        }[];
        variation?: number;
        rollout?: {
          variations: {
            variation: number;
            weight: number;
          }[];
        };
      }[];
      fallthrough?: {
        variation?: number;
        rollout?: {
          variations: {
            variation: number;
            weight: number;
          }[];
        };
      };
    }
  >;
};
type LaunchDarklyFlagVariation = LaunchDarklyFlag['variations'][number];
type WrappedLaunchDarklyFlagVariation = {
  name: string;
  value: Record<string, unknown>;
};
type LaunchDarklyFlagEnvironment = NonNullable<
  LaunchDarklyFlag['environments']
>[string];
type LaunchDarklyFlagRule = NonNullable<
  LaunchDarklyFlagEnvironment['rules']
>[number];
type LaunchDarklyFlagClause = NonNullable<
  LaunchDarklyFlagRule['clauses']
>[number];
type LaunchDarklyFlagFallthrough = NonNullable<
  LaunchDarklyFlagEnvironment['fallthrough']
>;

function transformFlagToConfig(
  flag: LaunchDarklyFlag,
  args: Args,
): TransformResult<StatsigConfig> {
  if (flag.kind === 'boolean') {
    return transformFlagToGate(flag, args);
  } else if (flag.kind === 'multivariate') {
    return transformFlagToDynamicConfig(flag, args);
  } else {
    return {
      transformed: false,
      errors: [
        {
          type: 'unsupported_flag_kind',
          flagKey: flag.key,
          flagKind: flag.kind,
        },
      ],
    };
  }
}

function transformFlagToGate(
  flag: LaunchDarklyFlag,
  args: Args,
): TransformResult<StatsigConfig> {
  const overrides: StatsigOverride[] = [];
  const rules: StatsigRule[] = [];
  const errors: TransformError[] = [];

  Object.entries(flag.environments || {}).forEach(([env, environmentData]) => {
    if (environmentData.targets && environmentData.targets.length > 0) {
      // Build the override object
      (environmentData.targets ?? [])
        .concat(environmentData.contextTargets ?? [])
        .forEach((overrideTarget) => {
          if (overrideTarget.values.length === 0) {
            return;
          }

          const contextKind = overrideTarget.contextKind ?? 'user';
          const unitID =
            contextKind === 'user'
              ? 'userID'
              : args.contextKindToUnitIDMapping?.[contextKind];
          if (!unitID) {
            errors.push({
              type: 'unit_id_not_mapped',
              contextKind,
              flagKey: flag.key,
            });
            return;
          }

          let environmentOverride = overrides.find(
            (o) =>
              o.unitID === unitID &&
              o.environment === (args.environmentNameMapping[env] ?? env),
          );
          if (!environmentOverride) {
            environmentOverride = {
              environment: args.environmentNameMapping[env] ?? env,
              unitID,
              passingIDs: [],
              failingIDs: [],
            };
            overrides.push(environmentOverride);
          }

          if (overrideTarget.variation == 0) {
            environmentOverride.passingIDs.push(...overrideTarget.values);
          } else if (overrideTarget.variation == 1) {
            environmentOverride.failingIDs.push(...overrideTarget.values);
          }
        });
    }

    for (const [ruleIndex] of (environmentData.rules ?? []).entries()) {
      const ruleResult = translateLaunchDarklyRule(
        flag.key,
        env,
        environmentData,
        ruleIndex,
        args,
      );
      if (ruleResult.transformed) {
        rules.push(ruleResult.result);
      } else {
        errors.push(...ruleResult.errors);
      }
    }

    const fallthroughRule = transformFallthroughRule(
      flag.key,
      env,
      environmentData,
      args,
    );
    if (fallthroughRule.transformed) {
      rules.push(fallthroughRule.result);
    } else {
      errors.push(...fallthroughRule.errors);
    }
  });

  if (errors.length > 0) {
    return {
      transformed: false,
      errors,
    };
  }

  return {
    transformed: true,
    result: {
      type: 'gate',
      gate: {
        id: flag.key,
        name: flag.name,
        description: flag.description,
        type: flag.temporary ? 'TEMPORARY' : 'PERMANENT',
        tags: flag.tags,
        rules,
      },
      overrides,
    },
  };
}

function transformFlagToDynamicConfig(
  flag: LaunchDarklyFlag,
  args: Args,
): TransformResult<StatsigConfig> {
  const rules: StatsigDynamicConfigRule[] = [];
  const errors: TransformError[] = [];

  let variations: WrappedLaunchDarklyFlagVariation[];
  let variationsWrapped = false;
  if (areVariationValuesObjects(flag.variations)) {
    variations = flag.variations;
  } else {
    variations = flag.variations.map(wrapVariationValues);
    variationsWrapped = true;
  }

  if (jsonContainsNull(variations)) {
    errors.push({
      type: 'return_value_contains_null',
      flagKey: flag.key,
    });
  }

  Object.entries(flag.environments || {}).forEach(([env, environmentData]) => {
    if (environmentData.targets && environmentData.targets.length > 0) {
      // Dynamic config doesn't support overrides, so we need to create a rule for each target
      (environmentData.targets ?? [])
        .concat(environmentData.contextTargets ?? [])
        .forEach((overrideTarget, idx) => {
          if (overrideTarget.values.length === 0) {
            return;
          }

          const contextKind = overrideTarget.contextKind ?? 'user';
          const unitID =
            contextKind === 'user'
              ? 'userID'
              : args.contextKindToUnitIDMapping?.[contextKind];
          if (!unitID) {
            errors.push({
              type: 'unit_id_not_mapped',
              contextKind,
              flagKey: flag.key,
            });
            return;
          }

          const rule: StatsigDynamicConfigRule = {
            name: `(${env}) ${flag.key} targets ${idx + 1}`,
            conditions: [
              contextKind === 'user'
                ? {
                    type: 'user_id',
                    operator: 'any',
                    targetValue: overrideTarget.values,
                  }
                : {
                    type: 'unit_id',
                    operator: 'any',
                    customID: unitID,
                    targetValue: overrideTarget.values,
                  },
            ],
            environments: [args.environmentNameMapping[env] ?? env],
            variants: [
              {
                name: variations[overrideTarget.variation].name,
                passPercentage: 100,
                returnValue: variations[overrideTarget.variation].value,
              },
            ],
          };
          rules.push(rule);
        });
    }

    for (const [ruleIndex] of (environmentData.rules ?? []).entries()) {
      const ruleResult = translateLaunchDarklyDynamicConfigRule(
        flag.key,
        env,
        environmentData,
        ruleIndex,
        variations,
        args,
      );
      if (ruleResult.transformed) {
        rules.push(ruleResult.result);
      } else {
        errors.push(...ruleResult.errors);
      }
    }

    const fallthroughRule = transformFallthroughDynamicConfigRule(
      flag.key,
      env,
      environmentData,
      variations,
      args,
    );
    if (fallthroughRule.transformed) {
      rules.push(fallthroughRule.result);
    } else {
      errors.push(...fallthroughRule.errors);
    }
  });

  if (errors.length > 0) {
    return {
      transformed: false,
      errors,
    };
  }

  return {
    transformed: true,
    result: {
      type: 'dynamic_config',
      dynamicConfig: {
        id: flag.key,
        name: flag.name,
        description: flag.description,
        tags: flag.tags,
        rules,
      },
    },
    notices: variationsWrapped
      ? [{ type: 'return_value_wrapped', flagKey: flag.key }]
      : undefined,
  };
}

// Translates a LaunchDarkly rule into one or more Statsig rules, accounting for complex segment matches.
function translateLaunchDarklyRule(
  flagKey: string,
  environmentName: string,
  flagEnvironment: LaunchDarklyFlagEnvironment,
  ruleIndex: number,
  args: Args,
): TransformResult<StatsigRule> {
  let passPercentage;
  const rule = nullthrows(flagEnvironment.rules?.[ruleIndex]);
  const errors: TransformError[] = [];

  if (!flagEnvironment.on) {
    // flag is off, display "offVariation"
    passPercentage = flagEnvironment.offVariation === 0 ? 100 : 0;
  } else {
    // Translate the launch darkly pass percentage to statsig pass percentage
    const passPercentageResult = transformRulePassPercentage(flagKey, rule);
    if (!passPercentageResult.transformed) {
      errors.push(...passPercentageResult.errors);
    } else {
      passPercentage = passPercentageResult.result;
    }
  }

  // Translate each clause within the rule to a Statsig condition.
  const conditions: StatsigCondition[] = [];
  for (const clause of rule.clauses) {
    const conditionResult = translateRuleClause(flagKey, clause, args);
    if (conditionResult.transformed) {
      conditions.push(conditionResult.result);
    } else {
      errors.push(...conditionResult.errors);
    }
  }

  if (errors.length > 0) {
    return {
      transformed: false,
      errors,
    };
  }

  //sending rule index to avoind 'Duplicate rule name(s) given' error for many unnamed rules
  const ruleName =
    '(' +
    environmentName +
    ') ' +
    (rule.description
      ? rule.description + ' import ' + (ruleIndex + 1)
      : 'import ' + (ruleIndex + 1));

  return {
    transformed: true,
    result: {
      name: capRuleName(ruleName),
      passPercentage: nullthrows(passPercentage),
      conditions,
      environments: [
        args.environmentNameMapping[environmentName] ?? environmentName,
      ],
    },
  };
}

function translateLaunchDarklyDynamicConfigRule(
  flagKey: string,
  environmentName: string,
  flagEnvironment: LaunchDarklyFlagEnvironment,
  ruleIndex: number,
  variations: WrappedLaunchDarklyFlagVariation[],
  args: Args,
): TransformResult<StatsigDynamicConfigRule> {
  const rule = nullthrows(flagEnvironment.rules?.[ruleIndex]);
  const errors: TransformError[] = [];
  let variantPercentages:
    | {
        variation: number;
        passPercentage: number;
      }[]
    | undefined;

  if (!flagEnvironment.on) {
    // flag is off, display "offVariation"
    if (flagEnvironment.offVariation == null) {
      errors.push({
        type: 'unsupported_off_variation',
        flagKey,
        flagEnvironmentName: environmentName,
      });
    } else {
      variantPercentages = [
        {
          variation: flagEnvironment.offVariation,
          passPercentage: 100,
        },
      ];
    }
  } else {
    const variantPercentagesResult = transformRuleVariantPercentages(
      flagKey,
      rule,
    );
    if (!variantPercentagesResult.transformed) {
      errors.push(...variantPercentagesResult.errors);
    } else {
      variantPercentages = variantPercentagesResult.result;
    }
  }

  // Translate each clause within the rule to a Statsig condition.
  const conditions: StatsigCondition[] = [];
  for (const clause of rule.clauses) {
    const conditionResult = translateRuleClause(flagKey, clause, args);
    if (conditionResult.transformed) {
      conditions.push(conditionResult.result);
    } else {
      errors.push(...conditionResult.errors);
    }
  }

  if (errors.length > 0) {
    return {
      transformed: false,
      errors,
    };
  }
  if (variantPercentages == null) {
    throw new Error('variantPercentages is null but should not be');
  }

  //sending rule index to avoind 'Duplicate rule name(s) given' error for many unnamed rules
  const ruleName =
    '(' +
    environmentName +
    ') ' +
    (rule.description
      ? rule.description + ' import ' + (ruleIndex + 1)
      : 'import ' + (ruleIndex + 1));

  return {
    transformed: true,
    result: {
      name: ruleName,
      conditions,
      environments: [
        args.environmentNameMapping[environmentName] ?? environmentName,
      ],
      variants: variantPercentages.map((variant) => ({
        name: variations[variant.variation].name,
        passPercentage: variant.passPercentage,
        returnValue: variations[variant.variation].value,
      })),
    },
  };
}

function areVariationValuesObjects(
  variations: LaunchDarklyFlagVariation[],
): variations is WrappedLaunchDarklyFlagVariation[] {
  // Statsig only supports objects for return values, but LaunchDarkly can be
  // arbitrary. We need to wrap it if any of the variations in LD are not objects.
  return !variations.some(
    (variation) =>
      Array.isArray(variation.value) ||
      typeof variation.value === 'boolean' ||
      typeof variation.value === 'number' ||
      typeof variation.value === 'string' ||
      variation.value == null,
  );
}

function wrapVariationValues(
  variation: LaunchDarklyFlagVariation,
): WrappedLaunchDarklyFlagVariation {
  return {
    name: variation.name,
    value: {
      [RETURN_VALUE_WRAP_ATTRIBUTE]: variation.value,
    },
  };
}

function transformFallthroughRule(
  flagKey: string,
  environmentName: string,
  flagEnvironment: LaunchDarklyFlagEnvironment,
  args: Args,
): TransformResult<StatsigRule> {
  const ruleName = '(' + environmentName + ') Fall through imported rule';

  const fallthroughRule: StatsigRule = {
    name: capRuleName(ruleName),
    passPercentage: 0,
    conditions: [{ type: 'public' }],
    environments: [
      args.environmentNameMapping[environmentName] ?? environmentName,
    ],
  };

  if (!flagEnvironment.on) {
    fallthroughRule.passPercentage =
      flagEnvironment.offVariation == 0 ? 100 : 0;
  } else if (flagEnvironment.fallthrough) {
    const passPercentageResult = transformRulePassPercentage(
      flagKey,
      flagEnvironment.fallthrough,
    );
    if (!passPercentageResult.transformed) {
      return passPercentageResult;
    } else {
      fallthroughRule.passPercentage = passPercentageResult.result;
    }
  }

  return {
    transformed: true,
    result: fallthroughRule,
  };
}

function transformFallthroughDynamicConfigRule(
  flagKey: string,
  environmentName: string,
  flagEnvironment: LaunchDarklyFlagEnvironment,
  variations: WrappedLaunchDarklyFlagVariation[],
  args: Args,
): TransformResult<StatsigDynamicConfigRule> {
  const ruleName = '(' + environmentName + ') Fall through imported rule';
  const errors: TransformError[] = [];

  const fallthroughRule: StatsigDynamicConfigRule = {
    name: ruleName,
    conditions: [{ type: 'public' }],
    environments: [
      args.environmentNameMapping[environmentName] ?? environmentName,
    ],
  };

  let variantPercentages;
  if (!flagEnvironment.on) {
    if (flagEnvironment.offVariation == null) {
      errors.push({
        type: 'unsupported_off_variation',
        flagKey,
        flagEnvironmentName: environmentName,
      });
    } else {
      variantPercentages = [
        {
          variation: flagEnvironment.offVariation,
          passPercentage: 100,
        },
      ];
    }
  } else if (flagEnvironment.fallthrough) {
    const variantPercentagesResult = transformRuleVariantPercentages(
      flagKey,
      flagEnvironment.fallthrough,
    );
    if (!variantPercentagesResult.transformed) {
      return variantPercentagesResult;
    } else {
      variantPercentages = variantPercentagesResult.result;
    }
  }

  if (errors.length > 0) {
    return {
      transformed: false,
      errors,
    };
  }
  if (variantPercentages == null) {
    throw new Error('variantPercentages is null but should not be');
  }

  fallthroughRule.variants = variantPercentages.map((variant) => ({
    name: variations[variant.variation].name,
    passPercentage: variant.passPercentage,
    returnValue: variations[variant.variation].value,
  }));

  return {
    transformed: true,
    result: fallthroughRule,
  };
}

function transformRulePassPercentage(
  flagKey: string,
  rule: LaunchDarklyFlagRule | LaunchDarklyFlagFallthrough,
): TransformResult<number> {
  if (rule.rollout) {
    // For rollouts, find the weight of the enabled variation and convert to a percentage.
    const variation = rule.rollout.variations[0];
    return {
      transformed: true,
      result: variation.weight / 1000, // Assuming weights are out of 100,000 for a percentage based on testing
    };
  } else if (rule.variation === 0) {
    return {
      transformed: true,
      result: 100,
    };
  } else if (rule.variation === 1) {
    return {
      transformed: true,
      result: 0,
    };
  } else {
    return {
      transformed: false,
      errors: [{ type: 'unsupported_pass_percentage', flagKey }],
    };
  }
}

function transformRuleVariantPercentages(
  flagKey: string,
  rule: LaunchDarklyFlagRule | LaunchDarklyFlagFallthrough,
): TransformResult<
  {
    variation: number;
    passPercentage: number;
  }[]
> {
  if (rule.rollout) {
    return {
      transformed: true,
      result: rule.rollout.variations.map((variation) => ({
        variation: variation.variation,
        passPercentage: variation.weight / 1000,
      })),
    };
  } else if (rule.variation != null) {
    return {
      transformed: true,
      result: [
        {
          variation: rule.variation,
          passPercentage: 100,
        },
      ],
    };
  } else {
    return {
      transformed: false,
      errors: [{ type: 'unsupported_pass_percentage', flagKey }],
    };
  }
}

function transformRuleClauseType(
  flagKey: string,
  clause: LaunchDarklyFlagClause,
  { contextKindToUnitIDMapping, contextCustomAttributeMapping }: Args,
): TransformResult<Pick<StatsigCondition, 'type' | 'field' | 'customID'>> {
  const contextKind = clause.contextKind ?? 'user';
  if (clause.attribute === 'key') {
    if (contextKind === 'user') {
      return {
        transformed: true,
        result: { type: 'user_id' },
      };
    }
    const unitID = contextKindToUnitIDMapping?.[contextKind];
    if (!unitID) {
      return {
        transformed: false,
        errors: [
          {
            type: 'unit_id_not_mapped',
            contextKind,
            flagKey,
          },
        ],
      };
    }
    return {
      transformed: true,
      result: {
        type: 'unit_id',
        customID: unitID,
      },
    };
  }

  const typeMapping: Record<string, StatsigConditionType> = {
    country: 'country',
    email: 'email',
    ip: 'ip_address',
  };
  if (typeMapping[clause.attribute]) {
    return {
      transformed: true,
      result: {
        type: typeMapping[clause.attribute],
      },
    };
  }

  const customField =
    contextCustomAttributeMapping?.[contextKind]?.[clause.attribute];
  if (!customField) {
    return {
      transformed: false,
      errors: [
        {
          type: 'custom_attribute_not_mapped',
          contextKind,
          attribute: clause.attribute,
          flagKey,
        },
      ],
    };
  }

  return {
    transformed: true,
    result: { type: 'custom_field', field: customField },
  };
}

function transformRuleOperator(
  flagKey: string,
  operator: string,
  negate: boolean,
): TransformResult<StatsigOperatorType> {
  const mapping: Record<string, StatsigOperatorType> = {
    lessThan: negate ? 'gte' : 'lt',
    lessThanOrEqual: 'lte',
    greaterThan: negate ? 'lte' : 'gt',
    greaterThanOrEqual: 'gte',
    before: 'before',
    after: 'after',
    in: negate ? 'none' : 'any',
    matches: negate ? 'none' : 'str_matches',
    contains: negate ? 'str_contains_none' : 'str_contains_any',
    semVerEqual: 'version_eq',
    startsWith: 'str_matches',
    endsWith: 'str_matches',
  };

  // Logic to throw an error if the operator is not supported
  const statsigOperator = mapping[operator];
  if (statsigOperator) {
    return {
      transformed: true,
      result: statsigOperator,
    };
  } else {
    return {
      transformed: false,
      errors: [{ type: 'unsupported_operator', operator, flagKey }],
    };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isArrayOfPrimitives(
  values: unknown[],
): values is string[] | number[] | boolean[] {
  return (
    values.every((v) => typeof v === 'string') ||
    values.every((v) => typeof v === 'number') ||
    values.every((v) => typeof v === 'boolean')
  );
}

function transformClauseValuesForOperator(
  flagKey: string,
  operator: string,
  values: unknown[],
): TransformResult<StatsigCondition['targetValue']> {
  if (!isArrayOfPrimitives(values)) {
    return {
      transformed: false,
      errors: [{ type: 'invalid_clause_values', flagKey, operator, values }],
    };
  }
  switch (operator) {
    case 'startsWith':
      return {
        transformed: true,
        result: values.map((v) => `^${escapeRegex(v.toString())}`),
      };
    case 'endsWith':
      return {
        transformed: true,
        result: values.map((v) => `${escapeRegex(v.toString())}$`),
      };
    default:
      //LD allows you to run in clause against array of booleans
      //Statsig doesn't, must coerce to string
      return {
        transformed: true,
        result: values.map((value) =>
          typeof value != 'string' && typeof value != 'number'
            ? JSON.stringify(value)
            : value,
        ) as string[] | number[],
      };
  }
}

function translateRuleClause(
  flagKey: string,
  clause: LaunchDarklyFlagClause,
  args: Args,
): TransformResult<StatsigCondition> {
  const clauseTypeResult = transformRuleClauseType(flagKey, clause, args);
  const operatorResult = transformRuleOperator(
    flagKey,
    clause.op,
    clause.negate,
  );
  const valuesResult = transformClauseValuesForOperator(
    flagKey,
    clause.op,
    clause.values,
  );
  if (
    !clauseTypeResult.transformed ||
    !operatorResult.transformed ||
    !valuesResult.transformed
  ) {
    const errors = [];
    if (!clauseTypeResult.transformed) {
      errors.push(...clauseTypeResult.errors);
    }
    if (!operatorResult.transformed) {
      errors.push(...operatorResult.errors);
    }
    if (!valuesResult.transformed) {
      errors.push(...valuesResult.errors);
    }
    return {
      transformed: false,
      errors,
    };
  }
  const { type, field, customID } = clauseTypeResult.result;
  const operator = operatorResult.result;
  const targetValue = valuesResult.result;

  const ruleCondition: StatsigCondition = {
    type,
    field,
    customID,
    operator,
    targetValue,
  };

  return {
    transformed: true,
    result: ruleCondition,
  };
}

export async function listLaunchDarklyEnvironments({
  apiKey,
  projectID,
  throttle,
}: Args): Promise<StatsigEnvironment[]> {
  const response = await throttle(() =>
    fetch(`${BASE_URL}/projects/${projectID}/environments`, {
      headers: {
        Authorization: `${apiKey}`,
        'LD-API-Version': API_VERSION,
      },
    }),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to list LaunchDarkly environments: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.items.map(
    (item: {
      key: string;
      critical: boolean;
      approvalSettings?: { required: boolean };
    }) => ({
      name: item.key,
      isProduction: item.critical,
      requiresReview: item.approvalSettings?.required ?? false,
    }),
  );
}

export async function listLaunchDarklyContextKinds({
  apiKey,
  projectID,
  throttle,
}: Args): Promise<string[]> {
  const response = await throttle(() =>
    fetch(
      `${BASE_URL}/projects/${projectID}/context-kinds`,
      getRequestOptions({ apiKey }),
    ),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to list LaunchDarkly context kinds: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.items.map(
    (item: { key: string; description: string }) => item.key,
  );
}

export async function ensureLaunchDarklySetup(
  statsigEnvironments: StatsigEnvironment[],
  statsigUnitIDs: string[],
  args: Args,
): Promise<
  | { ok: true }
  | {
      ok: false;
      unmappedEnvironments: string[];
      invalidUnitIDs: string[];
      contextKindsWithoutUnitIDs: string[];
    }
> {
  const launchdarklyEnvironments = await listLaunchDarklyEnvironments(args);
  const unmappedEnvironments = launchdarklyEnvironments.filter(
    (environment) =>
      !statsigEnvironments.some(
        (statsigEnvironment) => statsigEnvironment.name === environment.name,
      ) && !args.environmentNameMapping[environment.name],
  );

  const launchdarklyContextKinds = await listLaunchDarklyContextKinds(args);

  const contextKindsAndUnitIDs = launchdarklyContextKinds.map((contextKind) => {
    let unitID;
    if (contextKind === 'user') {
      unitID = 'user_id';
    } else {
      unitID = args.contextKindToUnitIDMapping[contextKind];
    }
    return [contextKind, unitID] as const;
  });

  const invalidUnitIDs = contextKindsAndUnitIDs
    .map(([_, unitID]) => unitID)
    .filter(
      (unitID) =>
        unitID && unitID !== 'user_id' && !statsigUnitIDs.includes(unitID),
    );

  const contextKindsWithoutUnitIDs = contextKindsAndUnitIDs.filter(
    ([_, unitID]) => !unitID,
  );

  if (
    unmappedEnvironments.length > 0 ||
    invalidUnitIDs.length > 0 ||
    contextKindsWithoutUnitIDs.length > 0
  ) {
    return {
      ok: false,
      unmappedEnvironments: unmappedEnvironments.map((e) => e.name),
      invalidUnitIDs,
      contextKindsWithoutUnitIDs: contextKindsWithoutUnitIDs.map(
        ([contextKind]) => contextKind,
      ),
    };
  }
  return { ok: true };
}
