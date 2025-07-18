import {
  addStatsigGateOverrides,
  createStatsigGate,
  createStatsigTag,
  deleteStatsigGate,
  getStatsigGate,
  getStatsigTag,
} from './statsig';

import type { Args } from './statsig';
import { StatsigConfig } from './types';

export async function needToDeleteExistingImportedGates(
  gateNames: string[],
  args: Args,
): Promise<boolean> {
  for (const gateName of gateNames) {
    const gate = await getStatsigGate(gateName, args);
    if (gate) {
      return true;
    }
  }
  return false;
}

export async function deleteExistingImportedGates(
  gateNames: string[],
  importTag: string,
  args: Args,
): Promise<
  { ok: true } | { ok: false; existingGatesWithoutImportTag: string[] }
> {
  const existingGateNames = [];
  const existingGatesWithoutImportTag = [];
  for (const gateName of gateNames) {
    const gate = await getStatsigGate(gateName, args);
    if (gate) {
      existingGateNames.push(gate.name);
      if (!gate.tags?.includes(importTag)) {
        existingGatesWithoutImportTag.push(gate.name);
      }
    }
  }

  if (existingGatesWithoutImportTag.length > 0) {
    return {
      ok: false,
      existingGatesWithoutImportTag,
    };
  }

  for (const gateName of existingGateNames) {
    await deleteStatsigGate(gateName, args);
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
  }
}
