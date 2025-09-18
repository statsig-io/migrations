import StatsigLogger from './statsig-sdk';

export default function exitAndShutdownLogger({
  logger,
  message,
  exitCode,
}: {
  logger: StatsigLogger;
  message?: string;
  exitCode: number;
}) {
  if (exitCode === 1) {
    console.error(message);
    logger.logEvent('migration_script_error', message);
  }

  logger.shutdown();
  process.exit(exitCode);
}
