/**
 * Local Docker implementation of `SandboxProviderAdapter`.
 *
 * The layered Dockerfile (user Dockerfile + Kortix runtime layer) is composed
 * by the caller (snapshots/builder.ts); this adapter only knows how to turn
 * that context into a local image with `docker build`, read its state and
 * delete it.
 *
 * The image is tagged `<prefix><snapshotName>` — the same name the platform
 * records as the provider snapshot — so a session can boot it by name without
 * a registry in between. That is the whole point of the local provider: the
 * image never leaves the host.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { stageRuntimeBuildContext, type StagedContext } from '../build-context';
import type {
  BuildLogTap,
  BuildableTemplate,
  BuildSnapshotResult,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const execFileAsync = promisify(execFile);
const DOCKER_BIN = process.env.LOCAL_SANDBOX_DOCKER_BIN || 'docker';
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Where the build context is staged so the HOST's Docker daemon can read it.
 * This path is bind-mounted into the API container at the same location it has
 * on the host — a staged context inside the container's own filesystem is
 * invisible to the daemon, and the build fails with an unreadable context.
 */
function buildContextRoot(): string {
  return process.env.LOCAL_SANDBOX_BUILD_CONTEXT_DIR || '/buildctx';
}

/** The composed Dockerfile's name inside the staged context. */
function dockerfileName(ctx: StagedContext): string {
  return path.basename(ctx.composedPath);
}

function imageTag(snapshotName: string): string {
  const prefix = process.env.LOCAL_SANDBOX_IMAGE_PREFIX || 'kortix-snapshot:';
  return `${prefix}${snapshotName}`;
}

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync(DOCKER_BIN, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

class LocalAdapter implements SandboxProviderAdapter {
  readonly id = 'local';

  isConfigured(): boolean {
    // The socket decides: a CLI without a daemon is not a provider.
    try {
      execFileAsync(DOCKER_BIN, ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('LocalAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    const tag = imageTag(input.snapshotName);
    console.info(
      `[snapshots] ${input.snapshotName}: building locally (slug="${input.slug}", provider=local, tag=${tag})`,
    );

    const ctx: StagedContext = await stageRuntimeBuildContext({
      snapshotName: input.snapshotName,
      userDockerfile,
      runtimeProfile: input.runtimeProfile,
      appContext: input.appContext,
      isShared: input.isShared,
      containerRuntime: input.containerRuntime,
    });

    // The build context is staged INSIDE this container, but the Docker daemon
    // that runs the build is the HOST's — it cannot see this container's
    // filesystem. The context therefore has to be copied onto a path the host
    // can read: a directory bind-mounted into this container at the SAME path
    // it has on the host.
    const hostContextDir = path.join(buildContextRoot(), input.snapshotName);
    try {
      await rm(hostContextDir, { recursive: true, force: true });
      await mkdir(buildContextRoot(), { recursive: true });
      await execFileAsync('cp', ['-a', `${ctx.contextDir}/.`, hostContextDir], { timeout: 300_000 });

      // No `--progress=plain`: that flag needs the buildx plugin, which the
      // runtime image does not carry — the legacy builder prints its steps to
      // stdout anyway, and the flag turned every build into a CLI-level error
      // before Docker was ever reached.
      const { stdout, stderr } = await execFileAsync(
        DOCKER_BIN,
        ['build', '-f', path.join(hostContextDir, dockerfileName(ctx)), '-t', tag, hostContextDir],
        { timeout: BUILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      ).catch((err: unknown) => {
        const e = err as {
          stdout?: string;
          stderr?: string;
          message?: string;
          code?: string;
          errno?: number;
          signal?: string;
        };
        const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        for (const line of out.split('\n')) {
          if (line.trim()) tap?.onLine?.(line.trim());
        }
        const tail = out
          .split('\n')
          .filter((line) => line.trim())
          .slice(-30)
          .join('\n');
        throw new Error(
          `[local] snapshot build failed for ${input.snapshotName}: ` +
            `${e.message ?? String(err)} (code=${e.code ?? '?'} errno=${e.errno ?? '?'} signal=${e.signal ?? '?'})\n${tail}`,
        );
      });

      for (const line of `${stdout}${stderr}`.split('\n')) {
        if (line.trim()) tap?.onLine?.(line.trim());
      }

      const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], 30_000);
      console.info(`[snapshots] ${input.snapshotName}: built ${imageId}`);
      return { externalTemplateId: imageId };
    } finally {
      await rm(hostContextDir, { recursive: true, force: true }).catch(() => {});
      await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    try {
      await docker(['image', 'inspect', imageTag(snapshotName)], 30_000);
      return 'active';
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/no such image|not found/i.test(text)) return 'missing';
      return 'unknown';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    try {
      await docker(['image', 'rm', '-f', imageTag(snapshotName)], 120_000);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (!/no such image|not found/i.test(text)) throw err;
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    const prefix = (process.env.LOCAL_SANDBOX_IMAGE_PREFIX || 'kortix-snapshot:').replace(
      /[:/]/g,
      '',
    );
    const out = await docker(
      ['images', '--format', '{{.Repository}}:{{.Tag}}'],
      30_000,
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${prefix}:`))
      .map((line) => ({ name: line.slice(prefix.length + 1) }));
  }
}

export const localProvider = new LocalAdapter();
