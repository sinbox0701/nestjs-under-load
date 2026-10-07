// socket-proxy 경유 Docker Engine API 클라이언트(D10). 허용된 경로만 쓴다:
//   GET  /containers/json, /containers/<id>/json, (info·version 은 T-115 allowlist 에 추가 필요)
//   POST /containers/<id>/(start|stop|restart)
// 버전 접두(/v1.xx)는 붙이지 않는다. create·exec·이미지 API 는 부르지 않는다.
import type { ContainerInfo, DockerControl, DockerInfo } from '../ports.js';

export type DockerControlOptions = {
  /** socket-proxy 주소(예: http://socket-proxy:2375) */
  baseUrl: string;
  /** compose 프로젝트 라벨(`com.docker.compose.project`) 값 */
  composeProject: string;
  /** 요청 기본 제한 시간(ms). stop·restart 는 timeoutSec 만큼 더한다. 기본 30000 */
  timeoutMs?: number;
};

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}

const L_SERVICE = 'com.docker.compose.service';
const L_NUMBER = 'com.docker.compose.container-number';
const L_PROJECT = 'com.docker.compose.project';

type InspectJson = {
  Id: string;
  Name: string;
  Image: string;
  State?: { Status?: string };
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  HostConfig?: { NanoCpus?: number; Memory?: number; CpusetCpus?: string };
};

function toInfo(j: InspectJson): ContainerInfo {
  const labels = j.Config?.Labels ?? {};
  const nano = j.HostConfig?.NanoCpus ?? 0;
  const mem = j.HostConfig?.Memory ?? 0;
  const cpuset = j.HostConfig?.CpusetCpus ?? '';
  const number = Number(labels[L_NUMBER]);
  return {
    id: j.Id,
    name: j.Name.replace(/^\//, ''),
    service: labels[L_SERVICE] ?? '',
    number: Number.isInteger(number) && number > 0 ? number : 1,
    state: j.State?.Status ?? 'unknown',
    image: j.Config?.Image ?? '',
    imageId: j.Image,
    limits: { cpus: nano > 0 ? nano / 1e9 : null, memBytes: mem > 0 ? mem : null, cpuset: cpuset === '' ? null : cpuset },
  };
}

export function createDockerControl(opts: DockerControlOptions): DockerControl {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const defaultTimeout = opts.timeoutMs ?? 30_000;

  async function call(method: 'GET' | 'POST', path: string, okStatuses: number[], timeoutMs = defaultTimeout): Promise<unknown> {
    const res = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!okStatuses.includes(res.status)) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // 본문이 JSON 이 아니면 그대로
      }
      throw new DockerError(res.status, `Docker API ${method} ${path} → ${res.status}: ${msg.trim()}`);
    }
    return text === '' ? null : JSON.parse(text);
  }

  const enc = encodeURIComponent;

  const control: DockerControl = {
    async list(service) {
      const filters = JSON.stringify({ label: [`${L_SERVICE}=${service}`, `${L_PROJECT}=${opts.composeProject}`] });
      const rows = (await call('GET', `/containers/json?all=1&filters=${enc(filters)}`, [200])) as { Id: string }[];
      // 목록 응답에는 HostConfig 한도가 없어 inspect 로 채운다.
      const infos = await Promise.all(rows.map((r) => control.inspect(r.Id)));
      return infos.sort((a, b) => a.number - b.number);
    },
    async inspect(idOrName) {
      return toInfo((await call('GET', `/containers/${enc(idOrName)}/json`, [200])) as InspectJson);
    },
    async stop(idOrName, o) {
      const t = o?.timeoutSec;
      const q = t === undefined ? '' : `?t=${t}`;
      // 304 = 이미 정지(멱등)
      await call('POST', `/containers/${enc(idOrName)}/stop${q}`, [204, 304], defaultTimeout + (t ?? 10) * 1000);
    },
    async start(idOrName) {
      // 304 = 이미 실행 중(멱등)
      await call('POST', `/containers/${enc(idOrName)}/start`, [204, 304]);
    },
    async restart(idOrName, o) {
      const t = o?.timeoutSec;
      const q = t === undefined ? '' : `?t=${t}`;
      await call('POST', `/containers/${enc(idOrName)}/restart${q}`, [204], defaultTimeout + (t ?? 10) * 1000);
    },
    async info(): Promise<DockerInfo> {
      const i = (await call('GET', '/info', [200])) as { NCPU?: number; MemTotal?: number; ServerVersion?: string; OperatingSystem?: string };
      const v = (await call('GET', '/version', [200])) as { ApiVersion?: string };
      return {
        ncpu: i.NCPU ?? 0,
        memTotalBytes: i.MemTotal ?? 0,
        serverVersion: i.ServerVersion ?? '',
        operatingSystem: i.OperatingSystem ?? '',
        apiVersion: v.ApiVersion ?? '',
      };
    },
  };
  return control;
}
