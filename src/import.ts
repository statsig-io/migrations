import {
  StatsigConfig,
  StatsigConfigWrapper,
  StatsigGate,
  StatsigRule,
  StatsigSegment,
} from './types';
import {
  addStatsigGateOverrides,
  createStatsigDynamicConfig,
  createStatsigGate,
  createStatsigSegment,
  createStatsigTag,
  deleteStatsigDynamicConfig,
  deleteStatsigGate,
  deleteStatsigSegment,
  getStatsigDynamicConfig,
  getStatsigGate,
  getStatsigSegment,
  getStatsigTag,
} from './statsig';

import type { Args } from './statsig';

export type ImportResult<T> =
  | {
      imported: true;
      result: T;
      notice?: string;
    }
  | {
      imported: false;
      error: string;
    };

export type ConfigImportResult = {
  totalConfigImported: number | undefined;
  errorsByConfigName: Record<string, string>;
  noticesByConfigName: Record<string, string>;
};

export async function needToDeleteExistingImportedConfigs(
  configNames: string[],
  args: Args,
): Promise<boolean> {
  for (const configName of configNames) {
    const gate = await getStatsigGate(configName, args);
    if (gate) {
      return true;
    }
    const dynamicConfig = await getStatsigDynamicConfig(configName, args);
    if (dynamicConfig) {
      return true;
    }
    const segment = await getStatsigSegment(configName, args);
    if (segment) {
      return true;
    }
  }
  return false;
}

export async function deleteExistingImportedConfigs(
  configNames: string[],
  importTag: string,
  args: Args,
): Promise<
  | { ok: true }
  | {
      ok: false;
      existingGatesWithoutImportTag: string[];
      existingDynamicConfigsWithoutImportTag: string[];
      existingSegmentsWithoutImportTag: string[];
    }
> {
  const existingGates: StatsigGate[] = [];
  const existingDynamicConfigNames: string[] = [];
  const existingGatesWithoutImportTag: string[] = [];
  const existingDynamicConfigsWithoutImportTag: string[] = [];
  const existingSegments: StatsigSegment[] = [];
  const existingSegmentsWithoutImportTag: string[] = [];

  for (const configName of configNames) {
    const gate = await getStatsigGate(configName, args);
    const dynamicConfig = await getStatsigDynamicConfig(configName, args);
    const segment = await getStatsigSegment(configName, args);
    if (gate) {
      if (gate.tags?.includes(importTag)) {
        existingGates.push(gate);
      } else {
        existingGatesWithoutImportTag.push(configName);
      }
    } else if (dynamicConfig) {
      if (dynamicConfig.tags?.includes(importTag)) {
        existingDynamicConfigNames.push(configName);
      } else {
        existingDynamicConfigsWithoutImportTag.push(configName);
      }
    } else if (segment) {
      if (segment.tags?.includes(importTag)) {
        existingSegments.push(segment);
      } else {
        existingSegmentsWithoutImportTag.push(configName);
      }
    }
  }

  for (const dynamicConfigName of existingDynamicConfigNames) {
    await deleteStatsigDynamicConfig(dynamicConfigName, args);
  }
  const gatesFromDependentToIndependent = sortConfigsFromDependentToIndependent(
    existingGates,
    'gate',
  );
  for (const gate of gatesFromDependentToIndependent) {
    await deleteStatsigGate(gate.id, args);
  }
  const segmentsFromDependentToIndependent =
    sortConfigsFromDependentToIndependent(existingSegments, 'segment');
  for (const segment of segmentsFromDependentToIndependent) {
    await deleteStatsigSegment(segment.id, args);
  }

  if (
    existingGatesWithoutImportTag.length > 0 ||
    existingDynamicConfigsWithoutImportTag.length > 0 ||
    existingSegmentsWithoutImportTag.length > 0
  ) {
    return {
      ok: false,
      existingGatesWithoutImportTag,
      existingDynamicConfigsWithoutImportTag,
      existingSegmentsWithoutImportTag,
    };
  }

  return { ok: true };
}

export async function importConfigs(
  configs: StatsigConfigWrapper[],
  importTag: string,
  importTagDescription: string,
  args: Args,
): Promise<ConfigImportResult> {
  // Make sure the import tag exists
  const importTagExists = await getStatsigTag(importTag, args);
  if (!importTagExists) {
    await createStatsigTag(importTag, importTagDescription, args);
  }

  const importResults: ConfigImportResult = {
    totalConfigImported: 0,
    errorsByConfigName: {},
    noticesByConfigName: {},
  };

  const addImportResult = (
    importResult: ImportResult<StatsigConfig>,
    configName: string,
  ) => {
    if (importResult.imported) {
      importResults.totalConfigImported =
        (importResults.totalConfigImported || 0) + 1;
      if (importResult.notice) {
        importResults.noticesByConfigName[configName] = importResult.notice;
      }
    } else {
      importResults.errorsByConfigName[configName] = importResult.error;
    }
  };

  // Separate configs by type
  const segments: StatsigConfigWrapper[] = [];
  const gates: StatsigConfigWrapper[] = [];
  const dynamicConfigs: StatsigConfigWrapper[] = [];

  for (const config of configs) {
    switch (config.type) {
      case 'segment':
        segments.push(config);
        break;
      case 'gate':
        gates.push(config);
        break;
      case 'dynamic_config':
        dynamicConfigs.push(config);
        break;
      default:
        const never: never = config;
        throw new Error(`Unexpected config type: ${never}`);
    }
  }

  // Import in order: segments (ordered by dependencies) -> gates (ordered by dependencies) -> dynamic configs
  const segmentObjects = segments
    .filter(
      (config): config is StatsigConfigWrapper & { type: 'segment' } =>
        config.type === 'segment',
    )
    .map((config) => config.segment);
  const segmentsFromIndependentToDependent =
    sortConfigsFromDependentToIndependent(segmentObjects, 'segment').reverse();

  for (const segment of segmentsFromIndependentToDependent) {
    const importResult = await createStatsigSegment(
      { ...segment, tags: [...(segment.tags || []), importTag] },
      args,
    );

    addImportResult(importResult, segment.name);
  }

  const gateObjects = gates
    .filter(
      (config): config is StatsigConfigWrapper & { type: 'gate' } =>
        config.type === 'gate',
    )
    .map((config) => config.gate);
  const gatesFromIndependentToDependent = sortConfigsFromDependentToIndependent(
    gateObjects,
    'gate',
  ).reverse();

  const gateConfigMap = new Map(
    gates
      .filter(
        (config): config is StatsigConfigWrapper & { type: 'gate' } =>
          config.type === 'gate',
      )
      .map((config) => [config.gate.id, config]),
  );

  for (const gate of gatesFromIndependentToDependent) {
    const config = gateConfigMap.get(gate.id);
    if (!config) continue;

    const importResult = await createStatsigGate(
      {
        ...gate,
        tags: [...(gate.tags || []), importTag],
      },
      args,
    );

    if (importResult.imported && config.overrides.length > 0) {
      const overrideImportResult = await addStatsigGateOverrides(
        gate.name,
        config.overrides,
        args,
      );

      if (!overrideImportResult.imported) {
        importResult.notice = overrideImportResult.error;
      }
    }

    addImportResult(importResult, gate.name);
  }

  for (const config of dynamicConfigs) {
    if (config.type === 'dynamic_config') {
      const dynamicConfig = config.dynamicConfig;
      const importResult = await createStatsigDynamicConfig(
        {
          ...dynamicConfig,
          tags: [...(dynamicConfig.tags || []), importTag],
        },
        args,
      );

      addImportResult(importResult, dynamicConfig.name);
    }
  }

  return importResults;
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
          // In LD, a rule can target multiple segments, so we need to handle the case where the targetValue is an array
          const targetConfig = (
            Array.isArray(condition.targetValue)
              ? condition.targetValue.length > 0
                ? condition.targetValue[0]
                : undefined
              : condition.targetValue
          ) as string;
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
