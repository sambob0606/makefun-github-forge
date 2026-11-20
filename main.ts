// main.ts — the forge's entrypoint.
//
// Life of the process, in order:
//   1. Build the app and bind an ephemeral port (never a fixed one: the
//      trial environment owns 8080 and dials whatever port we report).
//   2. Tell the trial environment that port (POST {port} to
//      $MAKEFUN_ENV_URL/register). A 200 accepts it; a 409 means some other
//      entry registered first and this process simply waits its turn.
//      Anything else is retried, except 400/405, which mean the request
//      itself is wrong and end the run.
//   3. Ask the environment, over and over, whether the trial is over
//      (GET $MAKEFUN_ENV_URL/done) and stop only when it answers
//      {"done": true}.
//   4. Close the server and leave with status 0.
//
// Without MAKEFUN_ENV_URL there is no environment to talk to, so the
// process just serves on its bound port until it is killed — the shape
// local grading uses.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { Store } from './store.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const REQUEST_BUDGET_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff between attempts: doubling from 250ms, capped at 2s. */
function backoff(attempt: number): number {
  const doubled = FIRST_RETRY_MS * 2 ** Math.min(attempt, 8);
  return Math.min(LONGEST_RETRY_MS, doubled);
}

async function tellEnvPort(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const answer = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // The environment may still be coming up: any other failure retries.
    }
    await pause(backoff(attempt));
    attempt += 1;
  }
}

async function waitUntilDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const answer = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet means not done; poll again.
    }
    await pause(backoff(attempt));
    attempt += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp(new Store(), shopToken);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const where = server.address() as AddressInfo | null;
      if (where === null) reject(new Error('the server bound no port'));
      else resolve(where.port);
    });
  });
  process.stdout.write(`[entry] forge listening on 127.0.0.1:${port}\n`);

  if (envBase === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set; serving without an environment\n');
    // No environment to report to: serve until the process is killed.
    await new Promise<void>(() => {});
    return;
  }

  await tellEnvPort(port);
  process.stdout.write('[entry] registered with the environment; waiting for done\n');
  await waitUntilDone();
  process.stdout.write('[entry] environment is done; shutting down\n');
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[entry] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
