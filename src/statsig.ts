import type {
  StatsigDynamicConfig,
  StatsigEnvironment,
  StatsigGate,
  StatsigOverride,
  StatsigSegment,
} from './types';

import { ImportResult } from './import';

const BASE_URL = 'https://statsigapi.net/console/v1';
const API_VERSION = '20240601';

export const statsigApiThrottle = {
  limit: 10,
  interval: 500, //ms
};

export type Args = {
  apiKey: string;
  throttle: <T>(fn: () => Promise<T>) => () => Promise<T>;
};

function getRequestOptions(args: Args): RequestInit {
  return {
    headers: {
      'Content-Type': 'application/json',
      'STATSIG-API-KEY': args.apiKey,
      'STATSIG-API-VERSION': API_VERSION,
    },
  };
}

export async function listStatsigEnvironments(
  args: Args,
): Promise<StatsigEnvironment[]> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/environments`, getRequestOptions(args)),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to list Statsig environments: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.data.environments;
}

export async function listStatsigUnitIDs(args: Args): Promise<string[]> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/unit_id_types`, getRequestOptions(args)),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to list Statsig unit IDs: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.data.map((item: { name: string }) => item.name);
}

export async function getStatsigGate(
  gateName: string,
  args: Args,
): Promise<StatsigGate | null> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/gates/${gateName}`, {
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(
      `Failed to get Statsig gate: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.data;
}

export async function createStatsigGate(
  gate: StatsigGate,
  args: Args,
): Promise<ImportResult<StatsigGate>> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/gates`, {
      method: 'POST',
      ...getRequestOptions(args),
      body: JSON.stringify({
        id: gate.id,
        name: gate.name,
        description: gate.description,
        tags: gate.tags,
        type: gate.type,
        rules: gate.rules,
      }),
    }),
  )();
  if (!response.ok) {
    return {
      imported: false,
      error: `Failed to create Statsig gate: ${response.statusText} ${await response.text()}`,
    };
  }

  const data = await response.json();
  return {
    imported: true,
    result: data.data,
  };
}

export async function deleteStatsigGate(
  gateName: string,
  args: Args,
): Promise<void> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/gates/${gateName}`, {
      method: 'DELETE',
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to delete Statsig gate: ${response.statusText} ${await response.text()}`,
    );
  }
}

export async function addStatsigGateOverrides(
  gateName: string,
  overrides: StatsigOverride[],
  args: Args,
): Promise<ImportResult<void>> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/gates/${gateName}/overrides`, {
      method: 'POST',
      ...getRequestOptions(args),
      body: JSON.stringify({
        environmentOverrides: overrides,
      }),
    }),
  )();
  if (!response.ok) {
    return {
      imported: false,
      error: `Failed to create Statsig gate overrides: ${response.statusText} ${await response.text()}`,
    };
  }

  return {
    imported: true,
    result: undefined,
  };
}

export async function getStatsigDynamicConfig(
  dynamicConfigName: string,
  args: Args,
): Promise<StatsigDynamicConfig | null> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/dynamic_configs/${dynamicConfigName}`, {
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(
      `Failed to get Statsig dynamic config: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.data;
}

export async function createStatsigDynamicConfig(
  dynamicConfig: StatsigDynamicConfig,
  args: Args,
): Promise<ImportResult<StatsigDynamicConfig>> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/dynamic_configs`, {
      method: 'POST',
      ...getRequestOptions(args),
      body: JSON.stringify({
        id: dynamicConfig.id,
        name: dynamicConfig.name,
        description: dynamicConfig.description,
        tags: dynamicConfig.tags,
        rules: dynamicConfig.rules,
      }),
    }),
  )();
  if (!response.ok) {
    return {
      imported: false,
      error: `Failed to create Statsig dynamic config: ${response.statusText} ${await response.text()}`,
    };
  }
  const data = await response.json();
  return {
    imported: true,
    result: data.data,
  };
}

export async function deleteStatsigDynamicConfig(
  dynamicConfigName: string,
  args: Args,
): Promise<void> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/dynamic_configs/${dynamicConfigName}`, {
      method: 'DELETE',
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to delete Statsig dynamic config: ${response.statusText} ${await response.text()}`,
    );
  }
}

export async function getStatsigSegment(
  segmentName: string,
  args: Args,
): Promise<StatsigSegment | null> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/segments/${segmentName}`, {
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(
      `Failed to get Statsig segment: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.data;
}

export async function createStatsigSegment(
  segment: StatsigSegment,
  args: Args,
): Promise<ImportResult<StatsigSegment>> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/segments`, {
      method: 'POST',
      ...getRequestOptions(args),
      body: JSON.stringify({
        id: segment.id,
        name: segment.name,
        description: segment.description,
        type: segment.type,
        idType: segment.idType,
        tags: segment.tags,
        rules: segment.rules,
      }),
    }),
  )();
  if (!response.ok) {
    return {
      imported: false,
      error: `Failed to create Statsig segment: ${response.statusText} ${await response.text()}`,
    };
  }
  const data = await response.json();
  return {
    imported: true,
    result: data.data,
  };
}

export async function deleteStatsigSegment(
  segmentName: string,
  args: Args,
): Promise<void> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/segments/${segmentName}`, {
      method: 'DELETE',
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to delete Statsig segment: ${response.statusText} ${await response.text()}`,
    );
  }
}

export async function getStatsigTag(
  tagName: string,
  args: Args,
): Promise<string | null> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/tags/${tagName}`, {
      ...getRequestOptions(args),
    }),
  )();
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(
      `Failed to get Statsig tag: ${response.statusText} ${await response.text()}`,
    );
  }
  const data = await response.json();
  return data.data.name;
}

export async function createStatsigTag(
  tagName: string,
  description: string,
  args: Args,
): Promise<void> {
  const response = await args.throttle(() =>
    fetch(`${BASE_URL}/tags`, {
      method: 'POST',
      ...getRequestOptions(args),
      body: JSON.stringify({ name: tagName, description }),
    }),
  )();
  if (!response.ok) {
    throw new Error(
      `Failed to create Statsig tag: ${response.statusText} ${await response.text()}`,
    );
  }
}
