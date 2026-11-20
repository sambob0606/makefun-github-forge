// main.ts — the entrypoint: start the forge, register with the trial
// environment, and stay up until the environment says the trial is done.
//
//   node main.ts
//
// Environment (set by the trial harness):
//   MAKEFUN_ENV_URL     base URL of the environment (register + done)
//   MAKEFUN_SHOP_TOKEN  bearer token the suite calls this entry with
//   MAKEFUN_TRIAL_NOW   the trial's logical "now" (ISO 8601)
//   MAKEFUN_TRIAL_SEED  seed for any randomness (unused: this entry is
//                       deterministic and never rolls its own dice)
//
// Without MAKEFUN_ENV_URL the server just listens on an ephemeral port and
// prints it — handy for local smoke tests. It then runs until killed.

import { createAppServer } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const REGISTER_TIMEOUT_MS = 10_000;
const DONE_POLL_MS = 250;
const DONE_TIMEOUT_MS = 890_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SHOP_TOKEN}`,
        },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (response.ok) return;
      console.error(`register: ${url} answered HTTP ${response.status}`);
    } catch (error) {
      console.error(`register: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Date.now() - started > 60_000) {
      throw new Error('could not register with the trial environment');
    }
    await sleep(500);
  }
}

async function waitUntilDone(): Promise<void> {
  const url = `${ENV_URL}/done`;
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${SHOP_TOKEN}` },
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment may not be ready yet; keep polling.
    }
    if (Date.now() - started > DONE_TIMEOUT_MS) {
      throw new Error('timed out waiting for the trial to finish');
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<number> {
  const server = createAppServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`github-forge listening on 127.0.0.1:${port}`);

  let shutdown = false;
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (shutdown) {
        resolve();
        return;
      }
      shutdown = true;
      server.close(() => resolve());
    });
  process.on('SIGINT', () => void close().then(() => process.exit(0)));
  process.on('SIGTERM', () => void close().then(() => process.exit(0)));

  if (ENV_URL === '') {
    // Local mode: serve until killed.
    console.log('no MAKEFUN_ENV_URL set; serving locally until killed');
    await new Promise(() => undefined);
    return 0;
  }

  await register(port);
  console.log('registered with the trial environment');
  await waitUntilDone();
  console.log('trial done; shutting down');
  await close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
