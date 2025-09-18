import {
  deleteExistingImportedConfigs,
  importConfigs,
  needToDeleteExistingImportedConfigs,
} from './import';
import {
  ensureLaunchDarklySetup,
  getLaunchDarklyConfigs,
  getLdFlagMaintainer,
  getLdObjectUrl,
  launchdarklyApiThrottle,
} from './launchdarkly';
import {
  getConfigID,
  transformErrorToString,
  transformNoticeToString,
} from './util';
import {
  listStatsigEnvironments,
  listStatsigUnitIDs,
  statsigApiThrottle,
} from './statsig';

import { createObjectCsvWriter } from 'csv-writer';
import minimist from 'minimist';
import pThrottle from 'p-throttle';
import path from 'path';
import readline from 'readline';

const LAUNCHDARKLY_IMPORT_TAG = 'Imported from LaunchDarkly';
const LAUNCHDARKLY_IMPORT_TAG_DESCRIPTION = 'Imported from LaunchDarkly';

enum MigrateFrom {
  LaunchDarkly = 'launchdarkly',
}

export default async function cli(): Promise<void> {
  const argv = minimist(process.argv.slice(2));

  const from = argv.from;

  if (!from) {
    console.error('Missing required arguments: --from');
    process.exit(1);
  }

  const statsigApiKey = process.env.STATSIG_API_KEY;
  if (!statsigApiKey) {
    console.error(
      'Missing required environment variable: STATSIG_API_KEY. To generate a Statsig Console API key, see https://docs.statsig.com/sdk-keys/api-keys/',
    );
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
        'Missing required environment variable: LAUNCHDARKLY_API_KEY. To generate a LaunchDarkly API key, see https://launchdarkly.com/docs/home/account/api-create',
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

    const contextAttributeToCustomFieldMappingArg =
      argv['context-attribute-to-custom-field'];
    const contextCustomAttributeMapping =
      contextAttributeToCustomFieldMappingArg
        ? parseContextAttributeToCustomFieldMapping(
            !Array.isArray(contextAttributeToCustomFieldMappingArg)
              ? [contextAttributeToCustomFieldMappingArg]
              : contextAttributeToCustomFieldMappingArg,
          )
        : {};

    let environmentNameMappingArg = argv['environment-key-mapping'];
    const environmentNameMapping = environmentNameMappingArg
      ? Object.fromEntries(
          (!Array.isArray(environmentNameMappingArg)
            ? [environmentNameMappingArg]
            : environmentNameMappingArg
          ).map((e) => e.split('=')),
        )
      : {};

    const onlyEnvironmentArg = argv['only-environment'];
    const onlyEnvironments = onlyEnvironmentArg
      ? !Array.isArray(onlyEnvironmentArg)
        ? [onlyEnvironmentArg]
        : onlyEnvironmentArg
      : null;

    const launchdarklyThrottle = pThrottle(launchdarklyApiThrottle);
    const launchdarklyArgs = {
      apiKey: launchdarklyApiKey,
      projectID: launchdarklyProjectID,
      throttle: launchdarklyThrottle,
      contextKindToUnitIDMapping,
      contextCustomAttributeMapping,
      environmentNameMapping,
      onlyEnvironments,
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
          `Unmapped environments: ${launchDarklySetupResult.unmappedEnvironments.join(', ')}.\nUse --environment-key-mapping ld-env-key=statsig-env-key to specify a mapping (can specify multiple).`,
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

    const { configTransformResult, flags, segments } =
      await getLaunchDarklyConfigs(launchdarklyArgs);

    const ldFlagsByKey = new Map(flags.map((flag) => [flag.key, flag]));
    const ldSegmentsByKey = new Map(
      segments.map((segment) => [segment.key, segment]),
    );

    console.log('');
    console.log(
      `Found a total of ${configTransformResult.totalFlagCount} flags and ${configTransformResult.totalSegmentCount} segments in LaunchDarkly.`,
    );
    console.log('');
    console.log(
      `${configTransformResult.validConfigs.length} flags/segments can be imported:`,
    );

    const canBeImportedCsvOutputWriter = new CSVOutputWriter(
      path.join(process.cwd(), 'can_be_imported.csv'),
    );

    configTransformResult.validConfigs.forEach((config) => {
      const configName =
        config.type === 'gate'
          ? config.gate.name
          : config.type === 'dynamic_config'
            ? config.dynamicConfig.name
            : config.segment.name;

      const configID = getConfigID(config);
      const ldFlag = ldFlagsByKey.get(configID);
      const ldSegment = ldSegmentsByKey.get(configID);
      const ldType = ldFlag ? 'flag' : 'segment';

      console.log(
        `- ${config.type === 'gate' ? `[gate] ${configName}` : config.type === 'dynamic_config' ? `[dynamic config] ${configName}` : `[segment] ${configName}`}`,
      );
      const notices = configTransformResult.noticesByConfigName[configID];
      if (notices) {
        for (const notice of notices) {
          console.log(`  - ${transformNoticeToString(notice)}`);
        }
      }

      canBeImportedCsvOutputWriter.add({
        ld_name: configName,
        ld_key: configID,
        ld_url: getLdObjectUrl(configID, ldType, launchdarklyProjectID),
        ld_type: ldType,
        ld_project: launchdarklyProjectID,
        ld_creation_date: new Date(
          ldType === 'segment'
            ? (ldSegment?.creationDate ?? '')
            : (ldFlag?.creationDate ?? ''),
        ).toLocaleString(),
        statsig_name: configName,
        statsig_id: configID,
        statsig_type: config.type,
        statsig_url: undefined,
        statsig_created_time: undefined,
        maintainer:
          ldType === 'segment' ? 'Unknown' : getLdFlagMaintainer(ldFlag),
        reason: notices
          ?.map((notice) => transformNoticeToString(notice))
          .join(', '),
        actual_migration_status: undefined,
        can_be_imported: true,
      });
    });

    console.log(
      `\n${Object.keys(configTransformResult.errorsByConfigName).length} flags/segments cannot be imported:`,
    );
    Object.entries(configTransformResult.errorsByConfigName).forEach(
      ([configID, errors]) => {
        console.log(`- ${configID}:`);
        errors.forEach((error) => {
          console.log(`  - ${transformErrorToString(error)}`);
        });

        const ldFlag = ldFlagsByKey.get(configID);
        const ldSegment = ldSegmentsByKey.get(configID);
        const ldType = ldFlag ? 'flag' : 'segment';

        canBeImportedCsvOutputWriter.add({
          ld_name:
            ldType === 'segment'
              ? (ldSegment?.name ?? '')
              : (ldFlag?.name ?? ''),
          ld_key: configID,
          ld_url: getLdObjectUrl(configID, ldType, launchdarklyProjectID),
          ld_type: ldType,
          ld_project: launchdarklyProjectID,
          ld_creation_date: new Date(
            ldType === 'segment'
              ? (ldSegment?.creationDate ?? '')
              : (ldFlag?.creationDate ?? ''),
          ).toLocaleString(),
          statsig_name: undefined,
          statsig_id: undefined,
          statsig_type: undefined,
          statsig_url: undefined,
          statsig_created_time: undefined,
          maintainer:
            ldType === 'segment' ? 'Unknown' : getLdFlagMaintainer(ldFlag),
          reason: errors
            .map((error) => transformErrorToString(error))
            .join(', '),
          actual_migration_status: false,
          can_be_imported: false,
        });
      },
    );

    await canBeImportedCsvOutputWriter.commit();

    console.log('');
    const proceed = await getYesNo(
      'Proceed to import the flags/segments that can be imported?',
    );
    if (!proceed) {
      process.exit(0);
    }

    const actuallyMigratedCsvOutputWriter = new CSVOutputWriter(
      path.join(process.cwd(), 'actually_migrated_configs.csv'),
    );

    const validConfigNames = configTransformResult.validConfigs.map((config) =>
      config.type === 'gate'
        ? config.gate.id
        : config.type === 'dynamic_config'
          ? config.dynamicConfig.id
          : config.segment.id,
    );

    let configToImport = configTransformResult.validConfigs;
    if (
      await needToDeleteExistingImportedConfigs(validConfigNames, statsigArgs)
    ) {
      const proceed = await getYesNo(
        'Some LaunchDarkly flags you’re trying to import already exist in Statsig. Proceed to delete and re-import them?',
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
        const untaggedConfigIds =
          deleteExistingImportedConfigsResult.existingGatesWithoutImportTag
            .concat(
              deleteExistingImportedConfigsResult.existingDynamicConfigsWithoutImportTag,
            )
            .concat(
              deleteExistingImportedConfigsResult.existingSegmentsWithoutImportTag,
            );
        console.log('');
        console.log(
          `We avoid overriding Statsig configs that are not tagged with "${LAUNCHDARKLY_IMPORT_TAG}", so we cannot import these LaunchDarkly flags: ${untaggedConfigIds.join(', ')}.`,
        );
        console.log(
          `Please tag the corresponding gates, dynamic configs, or segments in Statsig with "${LAUNCHDARKLY_IMPORT_TAG}" or delete them manually, after which you can re-run the script to migrate those flags.`,
        );

        untaggedConfigIds.forEach((configID) => {
          const ldFlag = ldFlagsByKey.get(configID);
          const ldSegment = ldSegmentsByKey.get(configID);
          const ldType = ldFlag ? 'flag' : 'segment';

          actuallyMigratedCsvOutputWriter.add({
            ld_name:
              ldType === 'segment'
                ? (ldSegment?.name ?? '')
                : (ldFlag?.name ?? ''),
            ld_key: configID,
            ld_url: getLdObjectUrl(configID, ldType, launchdarklyProjectID),
            ld_type: ldType,
            ld_project: launchdarklyProjectID,
            ld_creation_date: new Date(
              ldType === 'segment'
                ? (ldSegment?.creationDate ?? '')
                : (ldFlag?.creationDate ?? ''),
            ).toLocaleString(),
            statsig_name: undefined,
            statsig_id: undefined,
            statsig_type: undefined,
            statsig_url: undefined,
            statsig_created_time: undefined,
            maintainer:
              ldType === 'segment' ? 'Unknown' : getLdFlagMaintainer(ldFlag),
            reason: `There is a Statsig config with the same id as this LD flag that are not tagged with "${LAUNCHDARKLY_IMPORT_TAG}". Please tag the Statsig config ${configID} with "${LAUNCHDARKLY_IMPORT_TAG}" or delete/rename it manually, after which you can re-run the script to migrate the flags.`,
            actual_migration_status: false,
            can_be_imported: true,
          });
        });

        configToImport = configToImport.filter((config) => {
          return !untaggedConfigIds.includes(getConfigID(config));
        });
      }
    }

    console.log('');

    const importConfigsResult = await importConfigs(
      configToImport,
      LAUNCHDARKLY_IMPORT_TAG,
      LAUNCHDARKLY_IMPORT_TAG_DESCRIPTION,
      statsigArgs,
    );

    const importedConfigs = importConfigsResult.filter(
      (result) => result.imported,
    );
    const notImportedConfigs = importConfigsResult.filter(
      (result) => !result.imported,
    );
    const totalConfigImported = importedConfigs.length;
    const totalConfigNotImported = notImportedConfigs.length;

    console.log(`Imported ${totalConfigImported} flags/segments to Statsig.`);

    importedConfigs.forEach((result) => {
      const {
        notice,
        result: { config, type: configType },
      } = result;
      if (notice) {
        console.log(`- ${config.name}:`);
        console.log(`  - ${notice}`);
      }

      const ldFlag = ldFlagsByKey.get(config.id);
      const ldSegment = ldSegmentsByKey.get(config.id);
      const ldType = ldFlag ? 'flag' : 'segment';
      const notices = (
        configTransformResult.noticesByConfigName[config.id] ?? []
      ).map((notice) => transformNoticeToString(notice));
      if (notice) {
        notices.push(notice);
      }

      actuallyMigratedCsvOutputWriter.add({
        ld_name: config.name,
        ld_key: config.id,
        ld_url: getLdObjectUrl(config.id, ldType, launchdarklyProjectID),
        ld_type: ldType,
        ld_project: launchdarklyProjectID,
        ld_creation_date: new Date(
          ldType === 'segment'
            ? (ldSegment?.creationDate ?? '')
            : (ldFlag?.creationDate ?? ''),
        ).toLocaleString(),
        statsig_name: config.name,
        statsig_id: config.id,
        statsig_type: configType,
        statsig_url: undefined, // TODO: Need to fetch the project ID using the API key
        statsig_created_time: undefined, // TODO: Add createdTime field to the types and retrieve them here
        maintainer:
          ldType === 'segment' ? 'Unknown' : getLdFlagMaintainer(ldFlag),
        reason: notices.join(', '),
        actual_migration_status: true,
        can_be_imported: true,
      });
    });

    if (totalConfigNotImported > 0) {
      console.log('');
      console.log(
        `\n${totalConfigNotImported} flags/segments cannot be imported:`,
      );

      notImportedConfigs.forEach((result) => {
        const { configId, error } = result;
        const ldFlag = ldFlagsByKey.get(configId);
        const ldSegment = ldSegmentsByKey.get(configId);
        const ldType = ldFlag ? 'flag' : 'segment';
        const notices = (
          configTransformResult.noticesByConfigName[configId] ?? []
        ).map((notice) => transformNoticeToString(notice));
        if (error) {
          notices.push(error);
        }

        console.log(`- ${configId}:`);
        console.log(`  - ${error}`);

        actuallyMigratedCsvOutputWriter.add({
          ld_name: ldFlag?.name ?? ldSegment?.name ?? '',
          ld_key: configId,
          ld_url: getLdObjectUrl(configId, ldType, launchdarklyProjectID),
          ld_type: ldType,
          ld_project: launchdarklyProjectID,
          ld_creation_date: new Date(
            ldType === 'segment'
              ? (ldSegment?.creationDate ?? '')
              : (ldFlag?.creationDate ?? ''),
          ).toLocaleString(),
          statsig_name: undefined,
          statsig_id: undefined,
          statsig_type: undefined,
          statsig_url: undefined,
          statsig_created_time: undefined,
          maintainer:
            ldType === 'segment' ? 'Unknown' : getLdFlagMaintainer(ldFlag),
          reason: notices.join(', '),
          actual_migration_status: false,
          can_be_imported: true,
        });
      });
    }

    actuallyMigratedCsvOutputWriter.concatenateFrom(
      canBeImportedCsvOutputWriter,
    );
    await actuallyMigratedCsvOutputWriter.commit();
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

function parseContextAttributeToCustomFieldMapping(
  contextAttributeToCustomFieldMappingArg: string[],
): Record<string, Record<string, string>> {
  const mapping: Record<string, Record<string, string>> = {};
  contextAttributeToCustomFieldMappingArg.forEach((e) => {
    if (typeof e !== 'string' || !e.includes('/') || !e.includes('=')) {
      console.error(
        `Invalid context attribute to custom field mapping: ${e}. Use --context-attribute-to-custom-field context-kind/attribute=custom-field-name to specify a mapping.`,
      );
      process.exit(1);
    }
    const [contextKind, rest] = e.split('/');
    const [attribute, customFieldName] = rest.split('=');
    if (!mapping[contextKind]) {
      mapping[contextKind] = {};
    }
    mapping[contextKind][attribute] = customFieldName;
  });
  return mapping;
}

type CSVOutput = {
  // LD
  ld_name: string;
  ld_key: string;
  ld_url: string;
  ld_type: string;
  ld_project: string;
  ld_creation_date: string;

  // Statsig
  statsig_name: string | undefined;
  statsig_id: string | undefined;
  statsig_type: string | undefined;
  statsig_url: string | undefined;
  statsig_created_time: string | undefined;

  maintainer: string;
  reason: string;
  actual_migration_status: boolean | undefined;
  can_be_imported: boolean | undefined;
};

class CSVOutputWriter {
  public records: CSVOutput[] = [];
  private outputPath: string;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  add(record: CSVOutput): void {
    this.records.push(record);
  }

  concatenateFrom(otherWriter: CSVOutputWriter): void {
    const existingByKey = new Set<string>(
      this.records.map((record) => record.ld_key),
    );

    otherWriter.records.forEach((record) => {
      if (!existingByKey.has(record.ld_key)) {
        this.records.push(record);
      }
    });
  }

  async commit(): Promise<void> {
    if (this.records.length === 0) {
      console.log('No records to write to CSV file.');
      return;
    }

    const csvWriter = createObjectCsvWriter({
      path: this.outputPath,
      header: [
        { id: 'ld_name', title: 'LD Name' },
        { id: 'ld_key', title: 'LD Key' },
        { id: 'ld_url', title: 'LD URL' },
        { id: 'ld_type', title: 'LD Type' },
        { id: 'ld_project', title: 'LD Project' },
        { id: 'ld_creation_date', title: 'LD Creation Date' },
        { id: 'statsig_name', title: 'Statsig Name' },
        { id: 'statsig_id', title: 'Statsig ID' },
        { id: 'statsig_type', title: 'Statsig Type' },
        { id: 'statsig_url', title: 'Statsig URL' },
        { id: 'statsig_created_time', title: 'Statsig Created Time' },
        { id: 'maintainer', title: 'Maintainer' },
        { id: 'reason', title: 'Reason' },
        { id: 'actual_migration_status', title: 'Actual Migration Status' },
        { id: 'can_be_imported', title: 'Can Be Imported' },
      ],
    });

    try {
      await csvWriter.writeRecords(this.records);
      console.log(
        `Successfully wrote ${this.records.length} records to ${this.outputPath}`,
      );
    } catch (error) {
      console.error(`Error writing CSV file: ${error}`);
      throw error;
    }
  }
}
