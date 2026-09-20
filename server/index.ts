import { ApplicationService } from './application.js';
import { readServiceConfig, ServiceConfigurationError } from './config.js';

async function main(): Promise<void> {
  const config = readServiceConfig(process.env);
  if (config.multiplayer.status === 'unavailable') {
    console.error('Multiplayer unavailable:', config.multiplayer.message);
  }
  const service = new ApplicationService(config, message => console.warn(message));
  const port = await service.listen();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().then(() => {
      console.info('Application service stopped.');
    }, error => {
      console.error('Application service shutdown failed:', error);
      process.exitCode = 1;
    });
  };
  service.server.on('error', error => {
    console.error('Application service failed:', error);
    process.exitCode = 1;
    stop();
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.info(`Application service ready on ${config.host}:${port}; multiplayer ${config.multiplayer.status}.`);
}

void main().catch(error => {
  console.error('Application service startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof ServiceConfigurationError ? 78 : 1;
});
