import { StatsigClient } from '@statsig/js-client';

const STATSIG_CLIENT_KEY = 'client-SGEw7BPWvhK4x9vpcaJtkeoOvezcaQ0Lz7zKl57KQwJ';

export default class StatsigLogger {
  private statsig: StatsigClient;
  private baseMetaData:
    | Record<string, string | number | boolean | null>
    | undefined;

  constructor() {
    this.statsig = new StatsigClient(
      STATSIG_CLIENT_KEY,
      {},
      {
        loggingEnabled: 'always',
      },
    );
  }

  addBaseMetaData(
    metaData?: Record<string, string | number | boolean | null> | null,
  ): void {
    this.baseMetaData = { ...this.baseMetaData, ...metaData };
  }

  logEvent(
    eventName: string,
    value?: string | number,
    eventMetadata?: Record<string, string | number | boolean | null> | null,
  ): void {
    this.statsig.logEvent(eventName, value, {
      event_source: '@statsig/migrations',
      ...this.baseMetaData,
      ...eventMetadata,
    });
  }

  logAndShutdown(
    eventName: string,
    value?: string | number,
    eventMetadata?: Record<string, string | number | boolean | null> | null,
  ): void {
    this.logEvent(eventName, value, eventMetadata);
    this.statsig.shutdown();
  }
}
