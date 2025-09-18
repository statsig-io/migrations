import { StatsigClient } from '@statsig/js-client';

const STATSIG_CLIENT_KEY = 'client-SGEw7BPWvhK4x9vpcaJtkeoOvezcaQ0Lz7zKl57KQwJ';

export default class StatsigLogger {
  private statsig: StatsigClient;
  private provider: string | undefined;

  constructor() {
    this.statsig = new StatsigClient(
      STATSIG_CLIENT_KEY,
      {},
      {
        loggingEnabled: 'always',
      },
    );
  }

  setProvider(provider: string): void {
    this.provider = provider;
  }

  async logEvent(
    eventName: string,
    value?: string | number,
    eventMetadata?: Record<string, string | number | boolean | null> | null,
  ): Promise<void> {
    this.statsig.logEvent(eventName, value, {
      event_source: '@statsig/migrations',
      from: this.provider ?? '',
      ...eventMetadata,
    });

    await this.statsig.flush();
  }

  shutdown(): void {
    this.statsig.shutdown();
  }
}
