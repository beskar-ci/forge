// G8: load smoke test. Ramps to 20 virtual users; fails if p95 latency > 800 ms or > 1 % errors.
// Run: docker run --rm -i -e BASE_URL=https://staging.example.com grafana/k6:1.8.3 run - < load/smoke.k6.js   (CI pins the digest)
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [{ duration: '30s', target: 20 }, { duration: '1m', target: 20 }, { duration: '15s', target: 0 }],
  thresholds: { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.BASE_URL;

export default function () {
  // TODO(harden): the hot paths, read-only or against a disposable test account.
  check(http.get(`${BASE}/`), { 'home 200': r => r.status === 200 });
  sleep(1);
}
