/**
 * HTTPS interceptor server on port 443
 */

import https from 'node:https';
import fs from 'node:fs';
import { SERVER_KEY_PATH, SERVER_CERT_PATH, MappingConfig } from './config';
import { createRouter } from './router';

export function startServer(
  mapping: MappingConfig,
  port: number = 443
): Promise<https.Server> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SERVER_KEY_PATH) || !fs.existsSync(SERVER_CERT_PATH)) {
      reject(new Error('Server certificates not found. Run "cmm setup" first.'));
      return;
    }

    const server = https.createServer(
      {
        key: fs.readFileSync(SERVER_KEY_PATH),
        cert: fs.readFileSync(SERVER_CERT_PATH),
      },
      createRouter(mapping)
    );

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES') {
        reject(new Error(`Port ${port} requires root privileges. Run with sudo.`));
      } else if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Is cmm already running?`));
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}
