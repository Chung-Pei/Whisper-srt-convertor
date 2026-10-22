import { defineConfig } from '@playwright/test';
import fs from 'fs';

// 3 個專案：
//   functional：離線、可在任何機器跑（含 dist-csp；dist 需先 npm run build）
//   perf：長媒體與效能／記憶體（需 --enable-precise-memory-info；單工、長逾時）
//   network：preview-panel.spec.ts（會下載真實模型，需要網路；沙盒無法執行）
const servers = [
  { command: 'npx serve -l 8080 .', url: 'http://localhost:8080/index.html', reuseExistingServer: true },
  { command: 'npx serve -l 8082 tests/baseline/v23_2', url: 'http://localhost:8082/index.html', reuseExistingServer: true },
];
if (fs.existsSync('dist/index.html')) {
  servers.push({ command: 'npx serve dist -l 8081', url: 'http://localhost:8081/index.html', reuseExistingServer: true });
}

export default defineConfig({
  workers: 1,
  webServer: servers,
  projects: [
    { name: 'functional', testMatch: /(dist-csp|round9-regression|round10-defaults-and-dictionary|round11-.*|round12-.*|round1[34]-.*)\.spec\.ts/, timeout: 120_000 },
    { name: 'perf', testMatch: /perf-.*\.spec\.ts/, timeout: 900_000,
      use: { launchOptions: { args: ['--enable-precise-memory-info'] } } },
    { name: 'network', testMatch: /preview-panel\.spec\.ts/, timeout: 180_000 },
  ],
});
