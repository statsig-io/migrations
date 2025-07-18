import {
  deleteExistingImportedConfigs,
  importConfigs,
  needToDeleteExistingImportedConfigs,
} from './import';
import {
  ensureLaunchDarklySetup,
  getLaunchDarklyConfigs,
  launchdarklyApiThrottle,
} from './launchdarkly';
import {
  listStatsigEnvironments,
  listStatsigUnitIDs,
  statsigApiThrottle,
} from './statsig';
import { transformErrorToString, transformNoticeToString } from './util';

import minimist from 'minimist';
import pThrottle from 'p-throttle';
import readline from 'readline';

const LAUNCHDARKLY_IMPORT_TAG = 'Imported from LaunchDarkly';
const LAUNCHDARKLY_IMPORT_TAG_DESCRIPTION = 'Imported from LaunchDarkly';

enum MigrateFrom {
  LaunchDarkly = 'launchdarkly',
}

async function main(): Promise<void> {
  const argv = minimist(process.argv.slice(2));

  const from = argv.from;

  if (!from) {
    console.error('Missing required arguments: --from');
    process.exit(1);
  }

  const statsigApiKey = process.env.STATSIG_API_KEY;
  if (!statsigApiKey) {
    console.error('Missing required environment variable: STATSIG_API_KEY');
    process.exit(1);
  }
  const statsigThrottle = pThrottle(statsigApiThrottle);
  const statsigArgs = {
    apiKey: statsigApiKey,
    throttle: statsigThrottle,
  };

  if (from === MigrateFrom.LaunchDarkly) {
    const launchdarklyApiKey = process.env.LAUNCHDARKLY_API_KEY;
    if (!launchdarklyApiKey) {
      console.error(
        'Missing required environment variable: LAUNCHDARKLY_API_KEY',
      );
      process.exit(1);
    }
    const launchdarklyProjectID = argv['launchdarkly-project-id'];
    if (!launchdarklyProjectID) {
      console.error('Missing required argument: --launchdarkly-project-id');
      process.exit(1);
    }

    const contextKindToUnitIDMappingArg = argv['context-kind-to-unit-id'];
    const contextKindToUnitIDMapping = contextKindToUnitIDMappingArg
      ? Object.fromEntries(
          (!Array.isArray(contextKindToUnitIDMappingArg)
            ? [contextKindToUnitIDMappingArg]
            : contextKindToUnitIDMappingArg
          ).map((e) => e.split('=')),
        )
      : {};

    let environmentNameMappingArg = argv['environment-name-mapping'];
    const environmentNameMapping = environmentNameMappingArg
      ? Object.fromEntries(
          (!Array.isArray(environmentNameMappingArg)
            ? [environmentNameMappingArg]
            : environmentNameMappingArg
          ).map((e) => e.split('=')),
        )
      : {};

    const launchdarklyThrottle = pThrottle(launchdarklyApiThrottle);
    const launchdarklyArgs = {
      apiKey: launchdarklyApiKey,
      projectID: launchdarklyProjectID,
      throttle: launchdarklyThrottle,
      contextKindToUnitIDMapping,
      environmentNameMapping,
    };

    const statsigEnvironments = await listStatsigEnvironments(statsigArgs);
    const statsigUnitIDs = await listStatsigUnitIDs(statsigArgs);

    const launchDarklySetupResult = await ensureLaunchDarklySetup(
      statsigEnvironments,
      statsigUnitIDs,
      launchdarklyArgs,
    );
    if (!launchDarklySetupResult.ok) {
      if (launchDarklySetupResult.unmappedEnvironments.length > 0) {
        console.log(
          `Unmapped environments: ${launchDarklySetupResult.unmappedEnvironments.join(', ')}.\nUse --environment-name-mapping ld-env-name=statsig-env-name to specify a mapping (can specify multiple).`,
        );
      }
      if (launchDarklySetupResult.invalidUnitIDs.length > 0) {
        console.log(
          `Invalid unit IDs specified for context kinds: ${launchDarklySetupResult.invalidUnitIDs.join(', ')}.`,
        );
      }
      if (launchDarklySetupResult.contextKindsWithoutUnitIDs.length > 0) {
        console.log(
          `Missing unit IDs for context kinds: ${launchDarklySetupResult.contextKindsWithoutUnitIDs.join(', ')}.\nUse --context-kind-to-unit-id context-kind=unit_id to specify a mapping (can specify multiple).`,
        );
      }
      process.exit(1);
    } else {
      console.log(
        'All environments exist in Statsig or have a mapping. All context kinds have mapped unit IDs in Statsig.',
      );
    }

    const configTransformResult =
      await getLaunchDarklyConfigs(launchdarklyArgs);

    console.log('');
    console.log(
      `Found a total of ${configTransformResult.totalConfigCount} flags in LaunchDarkly.`,
    );
    console.log('');
    console.log(
      `${configTransformResult.validConfigs.length} flags can imported:`,
    );
    configTransformResult.validConfigs.forEach((config) => {
      const configName =
        config.type === 'gate' ? config.gate.name : config.dynamicConfig.name;
      console.log(
        `- ${config.type === 'gate' ? `[gate] ${configName}` : `[dynamic config] ${configName}`}`,
      );
      const notices = configTransformResult.noticesByConfigName[configName];
      if (notices) {
        for (const notice of notices) {
          console.log(`  - ${transformNoticeToString(notice)}`);
        }
      }
    });
    console.log(
      `\n${Object.keys(configTransformResult.errorsByConfigName).length} flags cannot be imported:`,
    );
    Object.entries(configTransformResult.errorsByConfigName).forEach(
      ([configName, errors]) => {
        console.log(`- ${configName}:`);
        errors.forEach((error) => {
          console.log(`  - ${transformErrorToString(error)}`);
        });
      },
    );
    console.log('');
    const proceed = await getYesNo(
      'Proceed to import the flags that can be imported?',
    );
    if (!proceed) {
      process.exit(0);
    }

    const validConfigNames = configTransformResult.validConfigs.map((config) =>
      config.type === 'gate' ? config.gate.name : config.dynamicConfig.name,
    );
    if (
      await needToDeleteExistingImportedConfigs(validConfigNames, statsigArgs)
    ) {
      const proceed = await getYesNo(
        'There are existing imported gates or dynamic configs. Proceed to delete them?',
      );
      if (!proceed) {
        process.exit(0);
      }
      const deleteExistingImportedConfigsResult =
        await deleteExistingImportedConfigs(
          validConfigNames,
          LAUNCHDARKLY_IMPORT_TAG,
          statsigArgs,
        );
      if (!deleteExistingImportedConfigsResult.ok) {
        console.log(
          `Existing imported gates or dynamic configs without being tagged with "${LAUNCHDARKLY_IMPORT_TAG}": ${deleteExistingImportedConfigsResult.existingGatesWithoutImportTag.concat(deleteExistingImportedConfigsResult.existingDynamicConfigsWithoutImportTag).join(', ')}.`,
        );
        console.log(
          `Someone may have created those gates manually in Statsig. You can fix this by either tagging those gates with "${LAUNCHDARKLY_IMPORT_TAG}" or deleting them manually.`,
        );
        process.exit(1);
      }
    }

    await importConfigs(
      configTransformResult.validConfigs,
      LAUNCHDARKLY_IMPORT_TAG,
      LAUNCHDARKLY_IMPORT_TAG_DESCRIPTION,
      statsigArgs,
    );
    console.log(
      `Imported ${configTransformResult.validConfigs.length} flags to Statsig.`,
    );
  } else {
    console.error(
      `Invalid --from value. Available values: ${Object.values(MigrateFrom).join(', ')}`,
    );
    process.exit(1);
  }
}

async function getYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${question} (y/n) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

main();
