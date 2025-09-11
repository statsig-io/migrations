import type {
  ConfigTransformResult,
  StatsigCondition,
  StatsigConditionType,
  StatsigConfigWrapper,
  StatsigDynamicConfigRule,
  StatsigEnvironment,
  StatsigOperatorType,
  StatsigOverride,
  StatsigRule,
  StatsigSegment,
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
  contextCustomAttributeMapping: Record<string, Record<string, string>>;
  environmentNameMapping: Record<string, string>;
  onlyEnvironments: string[] | null;
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
      totalFlagCount: undefined,
      totalSegmentCount: undefined,
      validConfigs: [],
      noticesByConfigName: {},
      errorsByConfigName: { '': flagKeysResult.errors },
    };
  }
  const flags = await Promise.all(
    flagKeysResult.result.map((flagKey) => getFeatureFlag(flagKey, args)),
  );

  const flagsByKey = new Map(flags.map((flag) => [flag.key, flag]));

  const configTransformResult: ConfigTransformResult = {
    totalConfigCount: flagKeysResult.result.length,
    totalFlagCount: flagKeysResult.result.length,
    totalSegmentCount: undefined,
    validConfigs: [],
    noticesByConfigName: {},
    errorsByConfigName: {},
  };

  flags.forEach((flag) => {
    const transformResult = transformFlagToConfig(
      flag as LaunchDarklyFlag,
      flagsByKey,
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

  const environments = await listLaunchDarklyEnvironments(args);
  const envKeys = environments
    .map((env) => env.name)
    .filter(
      (envKey) =>
        args.onlyEnvironments == null || args.onlyEnvironments.includes(envKey),
    );
  const ldSegmentsByEnv = Object.fromEntries(
    await Promise.all(
      envKeys.map(
        async (envKey) =>
          [envKey, await listSegmentsByEnv(envKey, args)] as const,
      ),
    ),
  );
  const segmentResults = transformAllSegments(ldSegmentsByEnv, args);
  configTransformResult.totalSegmentCount = segmentResults.length;
  configTransformResult.totalConfigCount =
    flagKeysResult.result.length + segmentResults.length;
  for (const segmentResult of segmentResults) {
    if (segmentResult.transformed) {
      configTransformResult.validConfigs.push({
        type: 'segment',
        segment: segmentResult.result,
      });
    } else {
      segmentResult.errors.forEach((error) => {
        configTransformResult.errorsByConfigName[error.flagKey] =
          configTransformResult.errorsByConfigName[error.flagKey] || [];
        configTransformResult.errorsByConfigName[error.flagKey].push(error);
      });
    }
  }

  return configTransformResult;
}

type LaunchDarklySegment = {
  key: string;
  name: string;
  description: string | null;
  rules: LaunchDarklyFlagRule[];
  deleted: boolean;
  included: string[] | null;
  excluded: string[] | null;
  includedContexts:
    | {
        contextKind: string | null;
        values: string[] | null;
      }[]
    | null;
  excludedContexts:
    | {
        contextKind: string | null;
        values: string[] | null;
      }[]
    | null;
  unbounded: boolean;
};

async function listSegmentsByEnv(
  environment: string,
  { apiKey, projectID, throttle }: Args,
): Promise<LaunchDarklySegment[]> {
  const allSegments: LaunchDarklySegment[] = [];
  let nextPage = `${BASE_URL}/segments/${projectID}/${environment}`;
  do {
    try {
      const response = await throttle(() =>
        fetch(nextPage, getRequestOptions({ apiKey })),
      )();
      if (!response.ok) {
        throw new Error(
          `Failed to list LaunchDarkly segments: ${response.statusText} ${await response.text()}`,
        );
      }
      const data = await response.json();
      allSegments.push(...data.items);
      nextPage = data._links?.next?.href;
    } catch (error) {
      throw new Error(
        `Failed to list LaunchDarkly segments: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } while (nextPage);

  return allSegments;
}

function transformAllSegments(
  ldSegmentsByEnv: Record<string, LaunchDarklySegment[]>,
  args: Args,
): TransformResult<StatsigSegment>[] {
  const ldSegmentsGroupedByEnv: Record<string, LaunchDarklySegment>[] = [];
  for (const [env, ldSegments] of Object.entries(ldSegmentsByEnv)) {
    for (const ldSegment of ldSegments) {
      const ldSegmentByEnv = ldSegmentsGroupedByEnv.find(
        (ldSegments) => Object.values(ldSegments)[0].key === ldSegment.key,
      );
      if (!ldSegmentByEnv) {
        ldSegmentsGroupedByEnv.push({ [env]: ldSegment });
      } else {
        ldSegmentByEnv[env] = ldSegment;
      }
    }
  }
  return ldSegmentsGroupedByEnv.map((ldSegmentByEnv) =>
    transformSegment(ldSegmentByEnv, args),
  );
}

function transformSegment(
  ldSegmentByEnv: Record<string, LaunchDarklySegment>, // env -> segment
  args: Args,
): TransformResult<StatsigSegment> {
  const allLdSegments = Object.values(ldSegmentByEnv);
  const key = allLdSegments[0].key;
  const name = allLdSegments[0].name;
  const description = allLdSegments[0].description;

  if (allLdSegments.some((segment) => segment.unbounded)) {
    return {
      transformed: false,
      errors: [{ type: 'unsupported_segment_type', flagKey: key }],
    };
  }
  if (
    allLdSegments.some((segment) => (segment.excluded ?? []).length > 0) &&
    allLdSegments.some((segment) => (segment.excludedContexts ?? []).length > 0)
  ) {
    return {
      transformed: false,
      errors: [{ type: 'segment_has_exclusions', flagKey: key }],
    };
  }

  const rules: StatsigRule[] = [];
  Object.entries(ldSegmentByEnv).forEach(([env, ldSegment]) => {
    if (ldSegment.included && ldSegment.included.length > 0) {
      rules.push({
        name: `(${env}) Included user IDs`,
        passPercentage: 100,
        conditions: [
          {
            operator: 'any',
            targetValue: ldSegment.included,
            type: 'user_id',
          },
        ],
        environments: [args.environmentNameMapping[env] ?? env],
      });
    }

    if (ldSegment.includedContexts && ldSegment.includedContexts.length > 0) {
      ldSegment.includedContexts.forEach((context) => {
        if (context.values == null) {
          return;
        }
        rules.push({
          name: `(${env}) Included ${context.contextKind} IDs`,
          passPercentage: 100,
          conditions: [
            {
              operator: 'any',
              targetValue: context.values,
              ...(!context.contextKind || context.contextKind === 'user'
                ? {
                    type: 'user_id',
                  }
                : {
                    type: 'unit_id',
                    customID:
                      args.contextKindToUnitIDMapping[context.contextKind],
                  }),
            },
          ],
          environments: [args.environmentNameMapping[env] ?? env],
        });
      });
    }

    for (const [ruleIndex, rule] of (ldSegment.rules ?? []).entries()) {
      const ruleResult = translateLaunchDarklyRule(
        key,
        env,
        rule,
        ruleIndex,
        100,
        args,
      );
      if (ruleResult.transformed) {
        rules.push(ruleResult.result);
      }
    }
  });

  const segment: StatsigSegment = {
    id: key,
    name,
    description: description ?? undefined,
    type: 'rule_based',
    rules,
  };

  return {
    transformed: true,
    result: segment,
  };
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
        fetch(nextPage, getRequestOptions({ apiKey })),
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
): Promise<LaunchDarklyFlag> {
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
      prerequisites?: {
        key: string;
        variation: number;
      }[];
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
  flagsByKey: Map<string, LaunchDarklyFlag>,
  args: Args,
): TransformResult<StatsigConfigWrapper> {
  if (flag.kind === 'boolean') {
    return transformFlagToGate(flag, flagsByKey, args);
  } else if (flag.kind === 'multivariate') {
    return transformFlagToDynamicConfig(flag, flagsByKey, args);
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
  flagsByKey: Map<string, LaunchDarklyFlag>,
  args: Args,
): TransformResult<StatsigConfigWrapper> {
  const overrides: StatsigOverride[] = [];
  const rules: StatsigRule[] = [];
  const errors: TransformError[] = [];

  Object.entries(flag.environments || {}).forEach(([env, environmentData]) => {
    if (args.onlyEnvironments != null && !args.onlyEnvironments.includes(env)) {
      return;
    }

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

    const offVariationIndex = environmentData.offVariation;
    if (offVariationIndex == null) {
      return {
        transformed: false,
        errors: [{ type: 'unsupported_off_variation', flagKey: flag.key }],
      };
    }
    const offVariation = flag.variations[offVariationIndex];

    const preqRules = transformPrerequisitesRule({
      offVariation,
      flagKey: flag.key,
      flagEnvironment: environmentData,
      isFlagBoolean: true,
      flagsByKey,
      environmentName: env,
      args,
    });
    if (preqRules.transformed) {
      rules.push(...preqRules.result);
    } else {
      errors.push(...preqRules.errors);
    }

    const percentageOverride = !environmentData.on
      ? environmentData.offVariation === 0
        ? 100
        : 0
      : null;
    for (const [ruleIndex, rule] of (environmentData.rules ?? []).entries()) {
      const ruleResult = translateLaunchDarklyRule(
        flag.key,
        env,
        rule,
        ruleIndex,
        percentageOverride,
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
  flagsByKey: Map<string, LaunchDarklyFlag>,
  args: Args,
): TransformResult<StatsigConfigWrapper> {
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
    if (args.onlyEnvironments != null && !args.onlyEnvironments.includes(env)) {
      return;
    }
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

    const offVariationIndex = environmentData.offVariation;
    if (offVariationIndex == null) {
      return {
        transformed: false,
        errors: [{ type: 'unsupported_off_variation', flagKey: flag.key }],
      };
    }
    const offVariation = variations[offVariationIndex];

    const preqRules = transformPrerequisitesRule({
      flagKey: flag.key,
      offVariation,
      flagEnvironment: environmentData,
      isFlagBoolean: false,
      flagsByKey,
      environmentName: env,
      args,
    });
    if (preqRules.transformed) {
      rules.push(...preqRules.result);
    } else {
      errors.push(...preqRules.errors);
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
  rule: LaunchDarklyFlagRule,
  ruleIndex: number,
  percentageOverride: number | null,
  args: Args,
): TransformResult<StatsigRule> {
  let passPercentage;
  const errors: TransformError[] = [];

  if (percentageOverride != null) {
    passPercentage = percentageOverride;
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

function transformPrerequisitesRule({
  flagKey,
  offVariation,
  flagEnvironment,
  isFlagBoolean,
  flagsByKey,
  environmentName,
  args,
}: {
  flagKey: string;
  offVariation: LaunchDarklyFlagVariation;
  flagEnvironment: LaunchDarklyFlagEnvironment;
  isFlagBoolean: boolean;
  flagsByKey: Map<string, LaunchDarklyFlag>;
  environmentName: string;
  args: Args;
}): TransformResult<StatsigDynamicConfigRule[]> {
  const preqRules: StatsigDynamicConfigRule[] = [];

  // Statsig's rule equivalent of LD's offVariation, based on whether we're converting the flag into gate or dynamic config
  const passPercentageForGate = (offVariation.value as boolean) ? 100 : 0;
  const variantsForDynamicConfig = [
    {
      name: offVariation.name,
      passPercentage: 100,
      returnValue: offVariation.value as Record<string, unknown>,
    },
  ];
  const offVariationMapping = isFlagBoolean
    ? { passPercentage: passPercentageForGate }
    : { variants: variantsForDynamicConfig };

  for (const prerequisite of flagEnvironment.prerequisites ?? []) {
    const {
      key: prerequisiteFlagKey,
      variation: prerequisiteFlagVariationIndex,
    } = prerequisite;

    const prerequisiteFlag = flagsByKey.get(prerequisiteFlagKey);
    if (prerequisiteFlag == null) {
      return {
        transformed: false,
        errors: [
          {
            type: 'prerequisite_flag_does_not_exist',
            prerequisiteFlagKey,
            flagKey,
          },
        ],
      };
    }

    // Statsig configs can only depend on gates (boolean flags), not dynamic configs (multivariate flags)
    if (prerequisiteFlag.kind !== 'boolean') {
      return {
        transformed: false,
        errors: [
          {
            type: 'unsupported_prerequisite_flag_type',
            prerequisiteFlagKind: prerequisiteFlag.kind,
            prerequisiteFlagKey,
            flagKey,
          },
        ],
      };
    }

    const prerequisiteFlagEnvironment =
      prerequisiteFlag.environments?.[environmentName];

    const ruleName =
      '(' +
      environmentName +
      ') Imported prerequisite rule ' +
      prerequisiteFlagKey;

    // On LD, if the prerequisite flag is off, serve only the off variation
    // That maps to Statsig's rule: Everyone get served LD's offVariation 100% of the time
    if (!prerequisiteFlagEnvironment?.on) {
      return {
        transformed: true,
        result: [
          {
            name: ruleName,
            conditions: [{ type: 'public' }],
            ...offVariationMapping,
            environments: [
              args.environmentNameMapping[environmentName] ?? environmentName,
            ],
          },
        ],
      };
    }

    // prerequisiteFlagValue can only be a boolean, since prerequisite flag is boolean
    const prerequisiteFlagValue =
      prerequisiteFlag.variations[prerequisiteFlagVariationIndex].value;
    // On LD, if the prerequisite flag is on, the prerequisite flag is true, moves the user to the next targeting
    // The equivalent in Statsig is the fails_gate condition, serve the offVariation 100% of the time
    // On LD, if the prerequisite flag is on, the prerequisite flag is false, moves the user to the next targeting
    // The equivalent in Statsig is the passes_gate condition, serve the offVariation 100% of the time
    const conditionType = prerequisiteFlagValue ? 'fails_gate' : 'passes_gate';

    preqRules.push({
      name: ruleName,
      conditions: [{ type: conditionType, targetValue: prerequisiteFlagKey }],
      ...offVariationMapping,
      environments: [
        args.environmentNameMapping[environmentName] ?? environmentName,
      ],
    });
  }

  return {
    transformed: true,
    result: preqRules,
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
    // Yes this is correct - it's not notSegmentMatch and it's not not-segment-match.
    'not-segmentMatch': 'fails_segment',
    segmentMatch: 'passes_segment',
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
    contextCustomAttributeMapping[contextKind]?.[clause.attribute];
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
): TransformResult<StatsigOperatorType | undefined> {
  const mapping: Record<string, StatsigOperatorType | undefined> = {
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
    segmentMatch: undefined, // type indicates segment
  };

  // Logic to throw an error if the operator is not supported
  if (operator in mapping) {
    return {
      transformed: true,
      result: mapping[operator],
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
  const unmappedEnvironments = launchdarklyEnvironments
    .filter(
      (environment) =>
        args.onlyEnvironments == null ||
        args.onlyEnvironments.includes(environment.name),
    )
    .filter(
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
