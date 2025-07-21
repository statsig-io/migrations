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
import { StatsigConfig } from './types';

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
  const existingGateNames = [];
  const existingDynamicConfigNames = [];
  const existingGatesWithoutImportTag = [];
  const existingDynamicConfigsWithoutImportTag = [];
  const existingSegmentNames = [];
  const existingSegmentsWithoutImportTag = [];
  for (const configName of configNames) {
    const gate = await getStatsigGate(configName, args);
    const dynamicConfig = await getStatsigDynamicConfig(configName, args);
    const segment = await getStatsigSegment(configName, args);
    if (gate) {
      existingGateNames.push(configName);
      if (!gate.tags?.includes(importTag)) {
        existingGatesWithoutImportTag.push(configName);
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

  for (const gateName of existingGateNames) {
    await deleteStatsigGate(gateName, args);
  }
  for (const dynamicConfigName of existingDynamicConfigNames) {
    await deleteStatsigDynamicConfig(dynamicConfigName, args);
  }
  for (const segmentName of existingSegmentNames) {
    await deleteStatsigSegment(segmentName, args);
  }

  return { ok: true };
}

export async function importConfigs(
  configs: StatsigConfig[],
  importTag: string,
  importTagDescription: string,
  args: Args,
): Promise<void> {
  // Make sure the import tag exists
  const importTagExists = await getStatsigTag(importTag, args);
  if (!importTagExists) {
    await createStatsigTag(importTag, importTagDescription, args);
  }

  for (const config of configs) {
    if (config.type === 'gate') {
      const gate = config.gate;
      await createStatsigGate(
        {
          ...gate,
          tags: [...(gate.tags || []), importTag],
        },
        args,
      );
      if (config.overrides.length > 0) {
        await addStatsigGateOverrides(gate.name, config.overrides, args);
      }
    } else if (config.type === 'dynamic_config') {
      const dynamicConfig = config.dynamicConfig;
      await createStatsigDynamicConfig(
        {
          ...dynamicConfig,
          tags: [...(dynamicConfig.tags || []), importTag],
        },
        args,
      );
    } else if (config.type === 'segment') {
      const segment = config.segment;
      await createStatsigSegment(
        { ...segment, tags: [...(segment.tags || []), importTag] },
        args,
      );
    } else {
      const never: never = config;
      throw new Error(`Unexpected config type: ${never}`);
    }
  }
}
