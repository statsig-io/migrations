import { StatsigConfig, StatsigConfigWrapper, StatsigGate } from './types';
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
  const existingSegmentNames: string[] = [];
  const existingSegmentsWithoutImportTag: string[] = [];

  for (const configName of configNames) {
    const gate = await getStatsigGate(configName, args);
    const dynamicConfig = await getStatsigDynamicConfig(configName, args);
    const segment = await getStatsigSegment(configName, args);
    if (gate) {
      existingGates.push(gate);
      if (!gate.tags?.includes(importTag)) {
        existingGatesWithoutImportTag.push(gate.id);
      }
    } else if (dynamicConfig) {
      existingDynamicConfigNames.push(configName);
      if (!dynamicConfig.tags?.includes(importTag)) {
        existingDynamicConfigsWithoutImportTag.push(configName);
      }
    } else if (segment) {
      existingSegmentNames.push(configName);
      if (!segment.tags?.includes(importTag)) {
        existingSegmentsWithoutImportTag.push(configName);
      }
    }
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

  for (const segmentName of existingSegmentNames) {
    await deleteStatsigSegment(segmentName, args);
  }
  const gatesOrderedByDependencies = reorderGatesByDependencies(existingGates);
  for (const gate of gatesOrderedByDependencies) {
    await deleteStatsigGate(gate.id, args);
  }
  for (const dynamicConfigName of existingDynamicConfigNames) {
    await deleteStatsigDynamicConfig(dynamicConfigName, args);
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

  for (const config of configs) {
    let importResult: ImportResult<StatsigConfig | undefined>;
    if (config.type === 'gate') {
      const gate = config.gate;
      importResult = await createStatsigGate(
        {
          ...gate,
          tags: [...(gate.tags || []), importTag],
        },
        args,
      );
      if (importResult.imported && config.overrides.length > 0) {
        const overrideImportResult = await addStatsigGateOverrides(
          gate.id,
          config.overrides,
          args,
        );

        if (!overrideImportResult.imported) {
          importResult.notice = overrideImportResult.error;
        }
      }
    } else if (config.type === 'dynamic_config') {
      const dynamicConfig = config.dynamicConfig;
      importResult = await createStatsigDynamicConfig(
        {
          ...dynamicConfig,
          tags: [...(dynamicConfig.tags || []), importTag],
        },
        args,
      );
    } else if (config.type === 'segment') {
      const segment = config.segment;
      importResult = await createStatsigSegment(
        { ...segment, tags: [...(segment.tags || []), importTag] },
        args,
      );
    } else {
      const never: never = config;
      throw new Error(`Unexpected config type: ${never}`);
    }

    const configName =
      config.type === 'gate'
        ? config.gate.id
        : config.type === 'dynamic_config'
          ? config.dynamicConfig.name
          : config.segment.name;

    if (importResult.imported) {
      importResults.totalConfigImported =
        (importResults.totalConfigImported || 0) + 1;
      if (importResult.notice) {
        importResults.noticesByConfigName[configName] = importResult.notice;
      }
    } else {
      importResults.errorsByConfigName[configName] = importResult.error;
    }
  }

  return importResults;
}

/**
 * @param gates a list of gates
 * @returns a list of gates ordered by dependencies. if gate A depends on gate B, then gate A will be before gate B in the list.
 */
export function reorderGatesByDependencies(
  gates: StatsigGate[],
): StatsigGate[] {
  const gateMap = new Map<string, StatsigGate>(
    gates.map((gate) => [gate.id, gate]),
  );

  const dependencies = new Map<string, Set<string>>();
  for (const gate of gates) {
    dependencies.set(gate.id, new Set());
  }

  for (const gate of gates) {
    const gateName = gate.id;

    for (const rule of gate.rules) {
      for (const condition of rule.conditions) {
        if (
          condition.type === 'passes_gate' ||
          condition.type === 'fails_gate'
        ) {
          const targetGate = condition.targetValue as string;
          if (targetGate && gateMap.has(targetGate)) {
            dependencies.get(targetGate)?.add(gateName);
          }
        }
      }
    }
  }

  const result: StatsigGate[] = [];
  const remaining = new Set(gates.map((gate) => gate.id));

  while (remaining.size > 0) {
    let found = false;

    // Find a gate that has no remaining dependencies
    for (const gateName of remaining) {
      const deps = dependencies.get(gateName) || new Set();
      const hasUnresolvedDeps = Array.from(deps).some((dep) =>
        remaining.has(dep),
      );

      if (!hasUnresolvedDeps) {
        const gate = gateMap.get(gateName);
        if (gate) {
          result.push(gate);
          remaining.delete(gateName);
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
