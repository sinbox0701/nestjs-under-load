#!/usr/bin/env node
// compose 설정 정적 검사(AC-1~3). `docker compose config --format json`(전 프로필)을 읽어 보안 규칙을 확인한다.
//   node infra/compose/check-config.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'docker-compose.yml');
const repoRoot = path.resolve(here, '../..');

const CTL_SERVICES = ['web', 'orchestrator', 'grafana', 'nginx', 'postgres'];
const SOCK_MOUNTERS = ['socket-proxy', 'alloy', 'cadvisor'];

export function check(cfg) {
  const errors = [];
  const svcs = cfg.services ?? {};
  for (const [name, s] of Object.entries(svcs)) {
    for (const p of s.ports ?? []) {
      if (p.host_ip !== '127.0.0.1') errors.push(`AC-1 ${name}: 포트 ${p.published} host_ip=${p.host_ip ?? '(없음)'}`);
    }
  }
  for (const n of ['lab-net', 'obs-net', 'sock-net']) {
    if (cfg.networks?.[n]?.internal !== true) errors.push(`AC-2 ${n} 이 internal:true 가 아니다`);
  }
  if (cfg.networks?.['ctl-net']?.internal) errors.push('AC-2 ctl-net 은 internal 이면 안 된다');
  const onCtl = Object.entries(svcs).filter(([, s]) => 'ctl-net' in (s.networks ?? {})).map(([n]) => n).sort();
  if (onCtl.join() !== [...CTL_SERVICES].sort().join()) errors.push(`AC-2 ctl-net 서비스 ${onCtl} != ${CTL_SERVICES}`);
  for (const [name, s] of Object.entries(svcs)) {
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind') continue;
      const src = v.source;
      const outside = !(src === repoRoot || src.startsWith(repoRoot + path.sep));
      if (outside && !SOCK_MOUNTERS.includes(name)) errors.push(`AC-3 ${name}: 레포 밖 호스트 경로 마운트 ${src}`);
      if (/docker\.sock$/.test(src) && !SOCK_MOUNTERS.includes(name)) errors.push(`AC-3 ${name}: docker.sock 마운트`);
    }
  }
  for (const n of SOCK_MOUNTERS) {
    if (!(svcs[n]?.volumes ?? []).some((v) => /docker\.sock$/.test(v.source))) errors.push(`AC-3 ${n}: docker.sock 마운트가 없다(문서와 불일치)`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = execFileSync('docker', ['compose', '-f', file, '--profile', 'obs', '--profile', 'trace', 'config', '--format', 'json'], { encoding: 'utf8' });
  const errors = check(JSON.parse(json));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('compose 설정 검사 통과(AC-1~3)');
}
