import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The names `docker compose` looks for when no -f is given, in its own order. */
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/**
 * Drivers that work inside the shop's container run `docker compose` in the stack's folder. The
 * default folder is the current one, which is right for the CLI started there and wrong for anything
 * else — the lab, an MCP client — where the first order then failed deep in Docker with "no
 * configuration file provided". Checked before the first command, with the variable that fixes it.
 */
export function assertComposeDir(target: string, dir: string): void {
  if (process.env.COMPOSE_FILE) return; // docker compose's own override; it knows where the file is
  const abs = resolve(dir);
  if (COMPOSE_FILES.some((name) => existsSync(join(abs, name)))) return;
  throw new Error(
    `${target}: no docker-compose.yml in ${abs}. The driver runs commands in the shop's container and needs the ` +
    `folder of its compose stack: set LD_E2E_${target.toUpperCase()}_COMPOSE_DIR (or --compose-dir).`,
  );
}

/** Turns Docker's answer for a stopped stack into what to do about it; anything else passes through. */
export function explainComposeError(target: string, dir: string, error: unknown): Error {
  const text = String((error as { stderr?: string }).stderr ?? '') + String((error as Error).message ?? error);
  if (/is not running|no container found|No such container/i.test(text)) {
    return new Error(`${target}: the shop's container is not running — start it with \`docker compose up -d\` in ${resolve(dir)}`);
  }
  return error instanceof Error ? error : new Error(text);
}
