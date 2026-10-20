/**
 * Local Docker implementation of `SandboxProvider`.
 *
 * Daytona, E2B and Platinum all rent the machine an agent runs on from someone
 * else. A self-hosted deployment that wants no cloud bill and no external
 * account runs that machine as a plain Docker container on the same host as
 * the API — this provider is that path.
 *
 * What the platform asks of a sandbox does not change: a container that
 * answers the agent port (8000) with the kortix-agent daemon and is reachable
 * BY THE API CONTAINER. Because both live on the same Docker network, the
 * container name resolves through Docker DNS and the proxy reaches
 * `http://<container>:8000` without publishing a port on the host.
 *
 * The trade-off is deliberate and loud: the API container needs the host's
 * Docker socket to create these containers, and the Docker socket is
 * root-equivalent on the host. An agent that escapes its container is an
 * agent on the host. Run this provider only where that is acceptable.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../../config';
import { isOpencodePort } from '../../shared/opencode-ports';
import { serviceKeyForExternalId } from '../service-key';
import { classifyPtyWebSocketPath } from './pty-ingress';
import type {
  CreateSandboxOpts,
  ProvisioningStatus,
  ProvisioningTraits,
  ProvisionResult,
  ResolvedEndpoint,
  ResolvedSandboxIngress,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxIngressRequest,
  SandboxProvider,
  SandboxStartOptions,
} from './contract';
import type { SandboxStatus } from './status';

const execFileAsync = promisify(execFile);

/** The agent daemon's port inside the box (kortix-agent, `KORTIX_SERVICE_PORT`). */
const AGENT_PORT = 8000;
/** The App runtime's ingress port (the App supervisor, not the agent). */
const APP_INGRESS_PORT = 8080;
const DOCKER_BIN = process.env.LOCAL_SANDBOX_DOCKER_BIN || 'docker';
const LABEL_SANDBOX = 'kortix.sandbox=true';
const LABEL_SANDBOX_ID = 'kortix.sandbox.id';

export function localContainerName(externalId: string): string {
  return `kortix-sbx-${externalId}`;
}

/** The image a snapshot name maps to on this host. */
export function localImageTag(snapshotName: string): string {
  const prefix = config.LOCAL_SANDBOX_IMAGE_PREFIX || 'kortix-snapshot:';
  return `${prefix}${snapshotName}`;
}

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync(DOCKER_BIN, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function isMissingContainer(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no such container|not found/i.test(text);
}

interface DockerState {
  Status?: string;
  Running?: boolean;
  ExitCode?: number;
  StartedAt?: string;
}

export class LocalDockerProvider implements SandboxProvider {
  readonly name = 'local' as const;
  readonly provisioning: ProvisioningTraits = {
    async: true,
    stages: [{ id: 'container', progress: 50, message: 'starting local container' }],
  };

  /** The proxy may cache a resolved ingress; a local URL is stable per container. */
  readonly ingressCacheTtlMs = 5_000;

  private async inspect(externalId: string): Promise<DockerState | null> {
    try {
      const out = await docker(['inspect', '--format', '{{json .State}}', localContainerName(externalId)], 20_000);
      return JSON.parse(out) as DockerState;
    } catch (err) {
      if (isMissingContainer(err)) return null;
      throw err;
    }
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    const workloadType = opts.workloadType ?? 'session';
    const externalId = opts.sandboxId ?? randomUUID();
    const name = localContainerName(externalId);
    if (!opts.snapshot) {
      throw new Error('[local] create() requires a snapshot: the local provider boots images it built itself.');
    }
    const image = localImageTag(opts.snapshot);
    const network = config.LOCAL_SANDBOX_DOCKER_NETWORK;

    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      LABEL_SANDBOX,
      '--label',
      `${LABEL_SANDBOX_ID}=${externalId}`,
      // The platform owns the lifecycle (start/stop/remove are provider calls),
      // so Docker must not resurrect a box behind its back.
      '--restart',
      'no',
    ];
    if (network) args.push('--network', network);
    if (opts.resourceSpec?.cpuCores) args.push('--cpus', String(opts.resourceSpec.cpuCores));
    if (opts.resourceSpec?.memoryGb) args.push('--memory', `${opts.resourceSpec.memoryGb}g`);
    for (const [key, value] of Object.entries(opts.envVars ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(image);

    await docker(args, 300_000);

    const apiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');
    const ingressPort = workloadType === 'app' ? APP_INGRESS_PORT : AGENT_PORT;

    return {
      externalId,
      baseUrl: `${apiBase}/v1/p/${externalId}/${ingressPort}`,
      metadata: {
        provisionedBy: opts.userId,
        containerName: name,
        image,
      },
    };
  }

  /** The image's ENTRYPOINT starts the agent daemon; nothing to do here. */
  async ensureAppRuntimeStarted(_externalId: string): Promise<void> {}

  async start(externalId: string, _opts?: SandboxStartOptions): Promise<void> {
    try {
      await docker(['start', localContainerName(externalId)], 120_000);
    } catch (err) {
      if (!isMissingContainer(err)) throw err;
    }
  }

  /**
   * Nothing provider-native to renew: the platform's reaper owns the deadline
   * (`session_sandboxes.deadline_at`) and stops the box through `stop()`.
   */
  async renewLifecycle(_externalId: string): Promise<void> {}

  async stop(externalId: string): Promise<void> {
    try {
      await docker(['stop', '--time', '10', localContainerName(externalId)], 60_000);
    } catch (err) {
      if (!isMissingContainer(err)) throw err;
    }
  }

  async remove(externalId: string): Promise<void> {
    try {
      await docker(['rm', '-f', localContainerName(externalId)], 60_000);
    } catch (err) {
      if (!isMissingContainer(err)) throw err;
    }
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    const state = await this.inspect(externalId);
    if (!state) return 'removed';
    const status = state.Status;
    if (status === 'running') return 'running';
    if (status === 'created' || status === 'exited' || status === 'paused') return 'stopped';
    if (status === 'dead' || status === 'removing') return 'terminal';
    return 'unknown';
  }

  async exec(
    externalId: string,
    command: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(DOCKER_BIN, ['exec', localContainerName(externalId), ...command]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`[local] exec timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });
    });
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    const serviceKey = await serviceKeyForExternalId(externalId);
    if (!serviceKey) {
      throw new Error(`[local] no service key for sandbox ${externalId}`);
    }
    return {
      url: `http://${localContainerName(externalId)}:${AGENT_PORT}`,
      headers: { Authorization: `Bearer ${serviceKey}` },
    };
  }

  routeIngress(request: SandboxIngressRequest) {
    const ptyWebsocket =
      request.transport === 'websocket' && classifyPtyWebSocketPath(request.path) !== null;
    return {
      // The agent bridge serves the opencode half of the pair too — the box has
      // no separate opencode port to expose.
      effectivePort: isOpencodePort(request.port) || ptyWebsocket ? AGENT_PORT : request.port,
      websocket: ptyWebsocket
        ? {
            userContextQueryParam: '__kortix_user_context',
            queryDefaults: { cursor: '0' },
          }
        : undefined,
    };
  }

  async resolveIngress(
    externalId: string,
    request: SandboxIngressRequest,
  ): Promise<ResolvedSandboxIngress> {
    const route = this.routeIngress(request);
    const serviceKey = await serviceKeyForExternalId(externalId);
    const headers = serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {};
    return {
      url: `http://${localContainerName(externalId)}:${route.effectivePort}`,
      headers,
      effectivePort: route.effectivePort,
      websocket: route.websocket,
    };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const state = await this.inspect(externalId);
    if (!state) {
      throw new Error(`[local] sandbox ${externalId} does not exist on this host`);
    }
    if (state.Status !== 'running') {
      await this.start(externalId);
    }
  }

  async getProvisioningStatus(_sandboxId: string): Promise<ProvisioningStatus | null> {
    return null;
  }

  /** The containers this provider owns, so a teardown path can find strays. */
  async listManagedRunningSandboxes(): Promise<Array<{ externalId: string; createdAt: string }>> {
    const out = await docker(
      ['ps', '--filter', `label=${LABEL_SANDBOX}`, '--format', '{{.Label "kortix.sandbox.id"}}|{{.CreatedAt}}'],
      30_000,
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [externalId, createdAt] = line.split('|');
        return { externalId, createdAt: createdAt ?? '' };
      });
  }
}
