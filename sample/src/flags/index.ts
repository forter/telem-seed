import { OpenFeature } from '@openfeature/server-sdk';
import { MySqlFlagsProvider } from './MySqlFlagsProvider';

let flagsInitialized = false;
let _readyOverride: boolean | null = null;

export async function initFlags(): Promise<void> {
  await OpenFeature.setProviderAndWait(new MySqlFlagsProvider());
  flagsInitialized = true;
  console.log('OpenFeature: MySqlFlagsProvider initialized');
}

export function isFlagsReady(): boolean {
  if (_readyOverride !== null) return _readyOverride;
  return flagsInitialized;
}

export function __overrideFlagsReadyForTest(value: boolean | null): void {
  _readyOverride = value;
}

export async function isTopicBlocked(topic: string): Promise<boolean> {
  return OpenFeature.getClient().getBooleanValue(topic, false);
}
