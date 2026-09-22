export type MultiplayerAvailability =
  | { status: 'disabled'; reason: 'not_implemented' }
  | { status: 'unavailable'; reason: 'configuration_error'; message: string }
  | { status: 'rooms'; reason: 'not_implemented'; config: RoomConfig };

export interface ServiceConfig {
  port: number;
  host: string;
  staticRoot: string;
  privateFiles?: readonly string[];
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
  const host = env.LOW_PASS_SERVICE_HOST ?? '127.0.0.1';
  if (!isIP(host)) throw new ServiceConfigurationError('LOW_PASS_SERVICE_HOST must be an IP address.');
  const staticRoot = env.LOW_PASS_STATIC_ROOT ?? fileURLToPath(new URL('../../dist', import.meta.url));
  if (!isAbsolute(staticRoot) || staticRoot.includes('\0')) {
    throw new ServiceConfigurationError('LOW_PASS_STATIC_ROOT must be an absolute build-directory path.');
  }
  let multiplayer: MultiplayerAvailability = { status: 'disabled', reason: 'not_implemented' };
  if (env.LOW_PASS_MULTIPLAYER_ENABLED === 'true') {
    try { multiplayer = { status: 'rooms', reason: 'not_implemented', config: readRoomConfig(env, staticRoot) }; }
    catch (error) {
      if (!(error instanceof RoomConfigurationError)) throw error;
      multiplayer = { status: 'unavailable', reason: 'configuration_error', message: error.message };
    }
  } else if (env.LOW_PASS_MULTIPLAYER_ENABLED !== undefined && env.LOW_PASS_MULTIPLAYER_ENABLED !== 'false') {
    multiplayer = { status: 'unavailable', reason: 'configuration_error', message: 'LOW_PASS_MULTIPLAYER_ENABLED must be true or false.' };
  }
  return {
    host,
    staticRoot,
    privateFiles: [env.LOW_PASS_HOSTING_CODE_FILE, env.LOW_PASS_TURN_SECRET_FILE]
      .filter((path): path is string => !!path && isAbsolute(path)),
    port: integer(env, 'LOW_PASS_SERVICE_PORT', 8080, 65535),
    shutdownTimeoutMs: integer(env, 'LOW_PASS_SHUTDOWN_TIMEOUT_MS', 5000, 30_000),
    multiplayer,
  };
}
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRoomConfig, RoomConfigurationError } from './room-config.js';
import type { RoomConfig } from './room-config.js';
