export type MultiplayerAvailability =
  | { status: 'disabled'; reason: 'not_implemented' }
  | { status: 'unavailable'; reason: 'configuration_error'; message: string };

export interface ServiceConfig {
  port: number;
  shutdownTimeoutMs: number;
  multiplayer: MultiplayerAvailability;
}

export class ServiceConfigurationError extends Error {}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ServiceConfigurationError(`${key} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

export function readServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const disabled = env.LOW_PASS_MULTIPLAYER_ENABLED === undefined || env.LOW_PASS_MULTIPLAYER_ENABLED === 'false';
  return {
    port: integer(env, 'LOW_PASS_SERVICE_PORT', 8081, 65535),
    shutdownTimeoutMs: integer(env, 'LOW_PASS_SHUTDOWN_TIMEOUT_MS', 5000, 30_000),
    multiplayer: disabled ? { status: 'disabled', reason: 'not_implemented' } : {
      status: 'unavailable', reason: 'configuration_error',
      message: 'LOW_PASS_MULTIPLAYER_ENABLED must be false; multiplayer is not implemented in this build.',
    },
  };
}
