import { ApplicationService } from './application.js';
import { readServiceConfig } from './config.js';

async function main(): Promise<void> {
  const config = readServiceConfig(process.env);
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
  console.info(`Application service ready on 127.0.0.1:${port}; multiplayer disabled.`);
}

void main().catch(error => {
  console.error('Application service startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
