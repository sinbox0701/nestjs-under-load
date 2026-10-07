import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { ClientRequest } from 'node:http';
import { defineConfig } from 'vitest/config';
import type { ProxyOptions } from 'vite';

// 코드 실험실이 레포의 packs/**(learn.yaml·strategies 원문)를 빌드 시 가져온다 → 레포 루트를 허용.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// dev 프록시: /api → 오케스트레이터 공개 포트(접두 제거, nginx 와 같다), /ws 는 접두 그대로.
// 오케 Host 가드는 127.0.0.1:4000 만 허용하므로 changeOrigin 으로 Host 를 맞춘다.
// Origin 은 허용 목록(http://127.0.0.1:5173)이어야 한다. 포트가 밀려 다른 루프백 포트로 뜨면 그 값으로 고쳐 보낸다(dev 전용).
const ORCH = 'http://127.0.0.1:4000';
const ALLOWED_DEV_ORIGIN = 'http://127.0.0.1:5173';
const fixOrigin: NonNullable<ProxyOptions['configure']> = (proxy) => {
  const fix = (req: ClientRequest) => {
    const o = req.getHeader('origin');
    if (typeof o === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o))
      req.setHeader('origin', ALLOWED_DEV_ORIGIN);
  };
  proxy.on('proxyReq', fix);
  proxy.on('proxyReqWs', fix);
};

export default defineConfig({
  plugins: [react()],
  // 로컬 전용(DESIGN §13): 개발 서버는 루프백에만 바인딩한다.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': {
        target: ORCH,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
        configure: fixOrigin,
      },
      '/ws': { target: ORCH, changeOrigin: true, ws: true, configure: fixOrigin },
    },
  },
  preview: { host: '127.0.0.1' },
  build: {
    // Monaco는 코드 실험실 화면에서만 지연 로드한다. 청크가 커도 무대 화면에는 영향이 없다.
    chunkSizeWarningLimit: 4096,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
