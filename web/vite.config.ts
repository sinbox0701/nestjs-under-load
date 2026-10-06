import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 코드 실험실이 레포의 packs/**(learn.yaml·strategies 원문)를 빌드 시 가져온다 → 레포 루트를 허용.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 로컬 전용(DESIGN §13): 개발 서버는 루프백에만 바인딩한다.
  server: { host: '127.0.0.1', port: 5173, strictPort: false, fs: { allow: [repoRoot] } },
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
