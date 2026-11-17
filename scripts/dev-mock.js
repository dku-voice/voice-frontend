import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { pathToFileURL } from 'node:url';
import { createMockPaymentApi } from './mock-payment-api.js';
import { CHECKOUT_STORAGE_KEY } from '../src/domain/checkout.js';

export async function startMockDemo({ port = 5174 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('로컬 테스트 포트를 확인해 주세요.');
  const mock = createMockPaymentApi();
  await new Promise((resolve, reject) => {
    mock.server.once('error', reject);
    mock.server.listen(0, '127.0.0.1', resolve);
  });
  const target = `http://127.0.0.1:${mock.server.address().port}`;
  const overrides = {
    VITE_API_BASE_URL: '', VITE_AI_WS_URL: `ws://127.0.0.1:${mock.server.address().port}/ws/audio`,
    VITE_AI_SNAPSHOT_URL: '', VITE_TOSS_CLIENT_KEY: '', VITE_STORE_ID: 'store-default',
  };
  const original = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let vite;
  try {
    vite = await createServer({
      configFile: false, mode: 'local-mock', logLevel: 'warn',
      cacheDir: 'node_modules/.vite-local-mock',
      plugins: [react(), {
        name: 'local-mock-identity',
        transformIndexHtml(html) {
          const titled = html.replace(/<title>[\s\S]*?<\/title>/, '<title>로컬 모의 결제 | DKU Voice</title>');
          return { html: titled, tags: [{
            tag: 'script', injectTo: 'head-prepend',
            // This runs only on the separate local demo origin, never the normal site.
            children: `try { const marker = 'voice-local-mock-instance'; const instance = ${JSON.stringify(mock.instanceId)}; if (sessionStorage.getItem(marker) !== instance) { sessionStorage.removeItem(${JSON.stringify(CHECKOUT_STORAGE_KEY)}); sessionStorage.setItem(marker, instance); } } catch {}`,
          }] };
        },
      }],
      server: {
        host: '127.0.0.1', port, strictPort: true,
        proxy: {
          '/api': { target, changeOrigin: true },
          '/ai': { target, changeOrigin: true },
          '/ws': { target, changeOrigin: true, ws: true },
        },
      },
    });
    await vite.listen();
  } catch (error) {
    if (vite) await vite.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    throw error;
  }
  let closed = false;
  return {
    url: `http://127.0.0.1:${vite.httpServer.address().port}`,
    mock,
    vite,
    async close() {
      if (closed) return;
      closed = true;
      await vite.close();
      mock.server.closeAllConnections();
      await new Promise((resolve) => mock.server.close(resolve));
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const demo = await startMockDemo({ port: Number(process.env.MOCK_FRONTEND_PORT || 5174) });
    console.log(`로컬 모의 결제 테스트: ${demo.url}`);
    console.log('메뉴 담기 → 장바구니 결제하기 → 주문 금액 확인 → 결제하기');
    console.log('모든 주문/승인은 이 프로세스 메모리에서만 처리합니다. 실제 백엔드·토스 연결 검증이 아닙니다.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void demo.close().then(() => process.exit(0)); });
  } catch (error) {
    console.error(`로컬 테스트 실행 실패: ${error.message}`);
    process.exitCode = 1;
  }
}
