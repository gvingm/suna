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
import { rm } from 'node:fs/promises';
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

    try {
      const { stdout, stderr } = await execFileAsync(
        DOCKER_BIN,
        ['build', '--progress=plain', '-f', ctx.composedPath, '-t', tag, ctx.contextDir],
        { timeout: BUILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      ).catch((err: unknown) => {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        for (const line of out.split('\n')) {
          if (line.trim()) tap?.onLine?.(line.trim());
        }
        throw new Error(
          `[local] snapshot build failed for ${input.snapshotName}: ${e.message ?? String(err)}`,
        );
      });

      for (const line of `${stdout}${stderr}`.split('\n')) {
        if (line.trim()) tap?.onLine?.(line.trim());
      }

      const imageId = await docker(
        ['image', 'inspect', '--format', '{{.Id}}', tag],
        30_000,
      );
      console.info(`[snapshots] ${input.snapshotName}: built ${imageId}`);
      return { externalTemplateId: imageId };
    } finally {
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
