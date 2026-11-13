/**
 * 接口连通性诊断（前端报 502 / 401 / 超时时，先跑这个）
 *   node tools/diagnose.mjs <baseURL> <apiKey> [--gen]
 *
 * 逐段验证链路，定位是哪一跳挂了：
 *   1) TCP 能不能连上（DNS / 端口 / 防火墙）
 *   2) 不带 key 打 /api/health → 应该 401（说明公网到了我们这层）
 *   3) 带 key 打 /api/health → 200 + 号池额度
 *   4) 发一个非法参数请求 → 400 + code=bad_params（说明请求体链路通）
 *   5) 带 --gen 才真的生成一张（消耗 1 次额度，40~90s）
 *
 * 关键：我们服务返回的错误一定是 **JSON**，带 code 和 trace_id。
 * 如果拿到的是 HTML 的 "502 Bad Gateway"，那不是我们返回的，是中间网关（nginx/CDN）超时或挂了。
 */
import net from 'node:net';
import fs from 'node:fs';

const [, , baseArg, key, ...flags] = process.argv;
if (!baseArg || !key) {
  console.error('用法: node tools/diagnose.mjs <baseURL> <apiKey> [--gen]');
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');
const u = new URL(base);
const doGen = flags.includes('--gen');
const rows = [];
const ok = (name, detail) => rows.push(['PASS', name, detail]);
const bad = (name, detail) => rows.push(['FAIL', name, detail]);

const tcp = () => new Promise((resolve) => {
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const s = net.connect({ host: u.hostname, port }, () => { s.destroy(); resolve(true); });
  s.setTimeout(6000, () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(false));
});

async function req(path, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(base + path, { ...opts, signal: AbortSignal.timeout(opts.timeout || 30000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, ms: Date.now() - t0, trace: r.headers.get('x-trace-id') };
}

console.log(`诊断目标: ${base}\n`);

// 1) TCP
const reachable = await tcp();
reachable ? ok('TCP 连接', `${u.hostname}:${u.port || 80} 可连`)
          : bad('TCP 连接', `${u.hostname}:${u.port || 80} 连不上（DNS/端口/防火墙/隧道挂了）`);

// 2) 无 key
if (reachable) {
  try {
    const r = await req('/api/health');
    if (r.json && r.status === 401) ok('公网到达服务', `401 + JSON（${r.json.error || ''}）`);
    else if (r.json && r.status === 200) ok('公网到达服务', '200（当前没开公网强制鉴权）');
    else if (!r.json) bad('公网到达服务', `${r.status} 但不是 JSON，body 开头：${r.text.slice(0, 80)} → 中间网关返回的，不是我们`);
    else bad('公网到达服务', `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  } catch (e) {
    bad('公网到达服务', String(e.message || e));
  }

  // 3) 带 key
  try {
    const r = await req('/api/health', { headers: { Authorization: `Bearer ${key}` } });
    if (r.status === 200 && r.json?.ok) {
      ok('鉴权 + 后端', `200，号池剩余 ${r.json.backend?.quota} 次，trace=${r.trace}`);
    } else {
      bad('鉴权 + 后端', `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 160)}`);
    }
  } catch (e) {
    bad('鉴权 + 后端', String(e.message || e));
  }

  // 4) 请求体链路（不消耗额度）
  try {
    const r = await req('/v1/idphoto', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA', params: { mode: '__bad__' } }),
    });
    if (r.status === 400 && r.json?.code === 'bad_params') ok('请求体链路', '400 + code=bad_params（符合预期）');
    else if (r.status === 413) ok('请求体链路', '413 参考图过大（也说明链路通）');
    else bad('请求体链路', `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 200)}`);
  } catch (e) {
    bad('请求体链路', String(e.message || e));
  }

  // 5) 真生成（可选）
  if (doGen) {
    const photo = process.env.DIAG_PHOTO || 'out/probe.jpg';
    if (!fs.existsSync(photo)) {
      bad('真实生成', `找不到 ${photo}，设置 DIAG_PHOTO=<照片路径>`);
    } else {
      try {
        const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(photo).toString('base64');
        const r = await req('/api/idphoto', {
          method: 'POST',
          timeout: 300000,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, params: { mode: 'suit', suit: 'black-suit', bg: '438edb' } }),
        });
        if (r.status === 200 && r.json?.ok) ok('真实生成', `200，${(r.ms / 1000).toFixed(1)}s，${r.json.url}`);
        else bad('真实生成', `${r.status} code=${r.json?.code || '-'} ${(r.json?.detail || r.json?.error || r.text).toString().slice(0, 200)} trace=${r.trace}`);
      } catch (e) {
        bad('真实生成', String(e.message || e));
      }
    }
  }
}

console.log(rows.map(([s, n, d]) => `${s === 'PASS' ? '✔' : '✘'} ${n.padEnd(14)} ${d}`).join('\n'));
const failed = rows.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `\n${failed} 项失败。` : '\n全通。');
if (failed) {
  console.log(`
怎么读结果：
- 只挂「TCP 连接」       → 隧道/端口不通（frpc 掉了、frps 挂了、本机 8000 没起）
- 挂「公网到达服务」且 body 是 HTML → 中间有 nginx/CDN，502 是它给的（多半是上游超时 60s）
- 挂「鉴权 + 后端」      → key 错 / 没配 key / 限流 429
- 挂「真实生成」看 code  → upstream_policy（提示词被拒）/ upstream_quota（没额度）/ upstream_timeout（超时）/ ref_download_failed（参考图 URL 拉不到）
把失败那一行的 trace=xxxx 发给我们即可定位。`);
}
process.exitCode = failed ? 1 : 0;
