import { SPECS, CATEGORIES, BGS, SUITS, buildPrompt, buildRefinePrompt, findSpec } from './specs.js';
import {
  loadImg, fileToDataURL, downscaleForUpload, cropToSpec,
  canvasToJpeg, download, buildSheet, analyzeFraming,
} from './compose.js';

/* ------------------------------------------------------------------ 状态 */
const state = {
  cfg: null,
  status: null,
  photoImg: null,
  photoUrl: '',
  resultImg: null,
  resultUrl: '',
  specId: 1,
  mode: 'suit',          // suit | bg
  suit: 'black-suit',
  bg: '438edb',
  cleanShave: true,
  tidyHair: false,
  busy: false,
  startedAt: 0,
  error: '',
  lastMs: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ------------------------------------------------------------------ API */
const KEY_STORE = 'idphoto_api_key';
const apiKey = () => localStorage.getItem(KEY_STORE) || '';
function apiHeaders(extra = {}) {
  const k = apiKey();
  return { ...extra, ...(k ? { Authorization: 'Bearer ' + k } : {}) };
}

async function loadConfig() {
  try {
    state.cfg = await (await fetch('/api/config')).json();
    if (state.cfg.public === true) state.publicMode = true;
  } catch { state.cfg = {}; }
  refreshStatus();
}
async function refreshStatus() {
  try {
    const j = await (await fetch('/api/status', { headers: apiHeaders() })).json();
    state.status = j.backend || null;
    if (j.public === true) state.publicMode = true;
    state.authError = j.ok === false ? (j.error || '') : '';
  } catch { state.status = null; }
  paintStatus();
  // 状态是异步到的：制作/我的 两页依赖它，到货后补一次重绘
  if (state.cfg && /^#\/(make|mine)/.test(location.hash)) render();
}
function paintStatus() {
  const el = $('#statusChip');
  if (!el) return;
  const b = state.status;
  if (!b) {
    const needKey = /Authorization|API key/i.test(state.authError || '');
    el.innerHTML = `<span class="dot off"></span>${needKey ? '需要 API key' : '后端未知'}`;
    return;
  }
  if (!b.reachable) { el.innerHTML = '<span class="dot off"></span>生图后端离线'; return; }
  el.innerHTML = `<span class="dot"></span>号池 <b>${b.quota ?? '?'}</b> 次`;
}

async function generate(imageDataUrl, prompt) {
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      image: imageDataUrl,
      prompt,
      size: state.cfg?.gen?.size || '1024x1536',
      model: state.cfg?.gen?.model || 'gpt-image-2',
    }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: '返回不是 JSON' }));
  if (!r.ok || !j.ok) {
    const e = new Error(j.error || `HTTP ${r.status}`);
    e.detail = j.detail;
    e.hint = j.hint;
    throw e;
  }
  return j;
}

/* ------------------------------------------------------------------ 视图 */
function topbar() {
  return `
  <header class="topbar">
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M9 3h6l1.2 2H21v16H3V5h4.8zM12 8.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg></div>
    <h1>${esc(state.cfg?.app?.name || '标准证件照红蓝白')}</h1>
    <div class="spacer"></div>
    <span class="chip" id="statusChip"><span class="dot"></span>…</span>
  </header>`;
}

function viewHome() {
  const hot = SPECS.filter((s) => s.hot);
  return `
  ${topbar()}
  <section class="hero">
    <h2>${esc(state.cfg?.app?.title || '证件照在家一键拍摄')}</h2>
    <p>${esc(state.cfg?.app?.subtitle || '换正装 · 换底色 · 排版冲印')}　·　300dpi 可直投报名系统</p>
    <div class="hero-actions">
      <button class="pill" data-act="go-suit">换正装</button>
      <button class="pill ghost" data-act="go-bg">换底色</button>
      <button class="pill ghost" data-act="go-print">冲刷实体照</button>
    </div>
  </section>

  <div class="search">
    <svg viewBox="0 0 24 24"><path d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/></svg>
    <input id="q" placeholder="搜索您想拍摄的规格名称、尺寸" autocomplete="off" />
  </div>

  <div class="grid cards" id="quick">
    <div class="card click" data-act="go-make">
      <div class="name">拍摄证件照</div>
      <div class="meta">选照片 → AI 换装换底 → 导出</div>
      <span class="badge">立即制作</span>
    </div>
    <div class="card click" data-act="go-suit">
      <div class="name">一键换正装</div>
      <div class="meta">深色西装 / 白衬衫 / 学生装</div>
    </div>
    <div class="card click" data-act="go-bg">
      <div class="name">一键换底色</div>
      <div class="meta">红 / 蓝 / 白 / 深蓝 六色</div>
    </div>
    <div class="card click" data-act="go-sheet">
      <div class="name">冲印排版</div>
      <div class="meta">6 寸相纸自动排版带裁切线</div>
    </div>
  </div>

  <div class="section-title">热门规格 <small>官方像素口径</small></div>
  <div class="grid cards" id="hotGrid">
    ${hot.map(specCard).join('')}
  </div>

  <div class="section-title">按分类 <small>共 ${SPECS.length} 种</small></div>
  <div class="grid cards">
    ${CATEGORIES.map((c) => `
      <div class="card click" data-act="cat" data-cat="${esc(c)}">
        <div class="name">${esc(c)}</div>
        <div class="meta">${SPECS.filter((s) => s.cat === c).length} 种规格</div>
      </div>`).join('')}
  </div>
  `;
}

function specCard(s) {
  return `
  <div class="card click" data-act="pick" data-id="${s.id}">
    <div class="name">${esc(s.name)}</div>
    <div class="meta">${s.px[0]}×${s.px[1]} px · ${esc(s.mm)} mm</div>
    ${s.tag ? `<span class="badge">${esc(s.tag)}</span>` : ''}
  </div>`;
}

function viewSpecs(query = '') {
  const q = query.trim();
  const list = q ? SPECS.filter((s) => s.name.includes(q) || s.mm.includes(q) || String(s.px[0]).includes(q)) : SPECS;
  return `
  ${topbar()}
  <div class="section-title">全部规格 <small>${list.length} 种</small></div>
  <div class="search">
    <svg viewBox="0 0 24 24"><path d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/></svg>
    <input id="q2" value="${esc(q)}" placeholder="搜索规格名称 / 尺寸" autocomplete="off" />
  </div>
  <div class="grid cards">
    ${list.map(specCard).join('') || '<div class="card"><div class="meta">没有匹配的规格</div></div>'}
  </div>`;
}

function viewMake() {
  const spec = findSpec(state.specId);
  const busy = state.busy;
  const offline = !!(state.status && state.status.reachable === false);
  const elapsed = busy ? ((Date.now() - state.startedAt) / 1000).toFixed(0) : 0;
  const img = state.resultUrl || state.photoUrl;

  return `
  ${topbar()}
  <div class="make">
    <div>
      <div class="stage" id="stage">
        ${img
          ? `<img src="${img}" alt="预览" />`
          : `<div class="empty">
               <svg viewBox="0 0 24 24"><path d="M4 5h3l1.5-2h7L17 5h3v14H4zM12 8a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/></svg>
               先选一张正面照片（光线均匀、背景干净、露额头）<br/>比正装照更容易一次成功
             </div>`}
        ${state.resultUrl ? '<span class="tag">AI 结果</span>' : ''}
      </div>
      ${state.resultUrl && state.photoUrl ? `
        <div class="section-title">原图 / 结果 <small>点图切换</small></div>
        <div class="compare" id="cmp">
          <img class="thumb" style="width:100%;height:auto" src="${state.photoUrl}" alt="原图" data-act="show-orig" />
          <img class="thumb" style="width:100%;height:auto" src="${state.resultUrl}" alt="结果" data-act="show-result" />
        </div>` : ''}
    </div>

    <aside class="panel">
      <div class="field">
        <label>照片</label>
        <label class="drop" id="drop">
          <input type="file" accept="image/*" id="file" hidden />
          ${state.photoUrl ? '已选择 · 点击可更换照片' : '点击选择照片 / 拍照'}
        </label>
        ${state.photoUrl ? '<div class="thumbs"><img class="thumb" src="' + state.photoUrl + '" alt="选图"/></div>' : ''}
      </div>

      <div class="field">
        <label>规格</label>
        <div class="opts">
          ${SPECS.filter((s) => s.hot || s.id === state.specId).map((s) => `
            <button class="opt" data-act="spec" data-id="${s.id}" aria-pressed="${s.id === state.specId}">${esc(s.name)} · ${s.px[0]}×${s.px[1]}</button>
          `).join('')}
        </div>
        <div class="hint">当前：${esc(spec.name)}　${spec.px[0]}×${spec.px[1]} px　${esc(spec.mm)} mm　300dpi</div>
      </div>

      <div class="field">
        <label>处理方式</label>
        <div class="opts">
          <button class="opt" data-act="mode" data-mode="suit" aria-pressed="${state.mode === 'suit'}">换正装</button>
          <button class="opt" data-act="mode" data-mode="bg" aria-pressed="${state.mode === 'bg'}">只换底色</button>
        </div>
      </div>

      ${state.mode === 'suit' ? `
      <div class="field">
        <label>正装</label>
        <div class="opts">
          ${SUITS.map((s) => `<button class="opt" data-act="suit" data-id="${s.id}" aria-pressed="${s.id === state.suit}">${esc(s.name)}</button>`).join('')}
        </div>
      </div>` : ''}

      <div class="field">
        <label>底色</label>
        <div class="swatch">
          ${BGS.map((b) => `<button class="sw" style="background:${b.hex}" title="${esc(b.name)}" data-act="bg" data-id="${b.id}" aria-pressed="${state.bg === b.id}"></button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>细节（可多选）</label>
        <label class="check"><input type="checkbox" id="clean" ${state.cleanShave ? 'checked' : ''}/> 清理胡渣、肤色干净</label>
        <label class="check"><input type="checkbox" id="hair" ${state.tidyHair ? 'checked' : ''}/> 发型整理服帖、露出额头</label>
      </div>

      <button class="btn" id="gen" ${busy || !state.photoUrl || offline ? 'disabled' : ''}>
        ${offline ? '生图后端离线' : busy ? '生成中…' : (state.mode === 'suit' ? 'AI 换正装' : 'AI 换底色')}
      </button>
      ${offline ? '<div class="err">chatgpt2api 后端不可达：确认 DSH 在运行、38650 端口有 python 进程、代理 127.0.0.1:7890 开着</div>' : ''}

      ${busy ? `
        <div class="progress">
          <div class="bar"><i id="bar" style="width:8%"></i></div>
          <div class="hint" id="tick">已用时 ${elapsed}s　·　单张 40~90s，号池排队时会久一点</div>
        </div>` : ''}

      ${state.error ? `<div class="err">${esc(state.error)}</div>` : ''}

      ${state.resultUrl ? `
        <button class="btn sub" id="refine" ${busy ? 'disabled' : ''}>局部精修（只清胡渣 / 整理发丝，重画其余不动）</button>
        <div class="field" style="margin-top:16px">
          <label>导出</label>
          <button class="btn sub" data-act="export" data-id="${state.specId}">导出 ${esc(spec.name)} · ${spec.px[0]}×${spec.px[1]}（300dpi）</button>
          <button class="btn sub" data-act="export" data-id="1">导出 一寸 295×413</button>
          <button class="btn sub" data-act="export" data-id="10">导出 二寸 413×579</button>
          <button class="btn sub" data-act="sheet">排版 6 寸相纸（含裁切线）</button>
        </div>` : (state.photoUrl ? `
        <button class="btn sub" data-act="export" data-id="${state.specId}" style="margin-top:10px">直接裁剪原图导出（不换装）</button>` : '')}

      <div class="hint" style="margin-top:14px">
        生成走的是一次参考图编辑：把「换什么 + 底色 + 构图」写进同一个提示词，
        模型返回后由本地按证件照标准重新构图、写 300dpi。<br/>
        不做美颜；如报名系统要求"真实无修图"，建议只用换底色。
      </div>
    </aside>
  </div>`;
}

function viewMine() {
  const f = state.cfg?.features || {};
  const wx = state.cfg?.wechat || {};
  const row = (k, v, off) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${off ? '<span class="off-tag">已禁用</span>' : esc(v)}</span></div>`;
  return `
  ${topbar()}
  <div class="section-title">设置 <small>这一版是纯工具，没有账号体系</small></div>
  <div class="list">
    ${row('登录', '未启用', f.login === false)}
    ${row('会员 / 付费', '未启用', f.vip === false)}
    ${row('支付', '未启用', f.payment === false)}
    ${row('广告位', '已全部移除', false)}
    ${row('冲印下单', '未启用', f.print === false)}
    ${row('微信 AppID', wx.appId || '未填写（保留位）', false)}
    ${row('微信商户号', wx.mchId || '未填写（保留位）', false)}
    ${row('生图模型', state.cfg?.gen?.model || 'gpt-image-2', false)}
    ${row('生图后端', state.status?.reachable ? `在线 · 剩余 ${state.status.quota} 次` : '离线', false)}
    ${row('运行模式', state.publicMode ? '公网（所有接口需要 key）' : '本机同源（免 key）', false)}
  </div>

  <div class="section-title">API Key <small>公网访问时必填，只存在本机浏览器</small></div>
  <div class="list">
    <div class="row" style="gap:8px">
      <input id="apiKeyInput" type="password" placeholder="sk-idp-..." value="${esc(apiKey())}"
             style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px;outline:none" />
      <button class="opt" data-act="save-key">保存</button>
      <button class="opt" data-act="clear-key">清除</button>
    </div>
    ${state.authError ? `<div class="row"><span class="k">当前状态</span><span class="v" style="color:var(--danger)">${esc(state.authError)}</span></div>` : ''}
  </div>

  <div class="section-title">说明</div>
  <div class="note">
    这一版把小程序里那套「登录 / 会员 / 付费弹窗 / 广告位」全部摘掉了：
    打开就能用，生成不扣费，也没有任何广告组件。<br/>
    AppID 与商户号在 <code>config.json</code> 里留了空位，接自己的号时填进去，
    再把 <code>features</code> 里对应的开关打开即可（默认全关）。
  </div>`;
}

/* ------------------------------------------------------------------ 渲染 */
let query = '';
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabOf(path)));
  return { path, qs };
}
function tabOf(path) {
  if (path.startsWith('/specs')) return 'specs';
  if (path.startsWith('/make')) return 'make';
  if (path.startsWith('/mine')) return 'mine';
  return 'home';
}

function render() {
  const { path } = route();
  if (!state.cfg) { app.innerHTML = '<div class="boot">正在加载…</div>'; return; }

  if (path.startsWith('/make')) app.innerHTML = viewMake();
  else if (path.startsWith('/specs')) app.innerHTML = viewSpecs(query);
  else if (path.startsWith('/mine')) app.innerHTML = viewMine();
  else app.innerHTML = viewHome();

  paintStatus();
  wire(path);
  if (state.busy) startTicker();
}

/* ------------------------------------------------------------------ 交互 */
function wire(path) {
  // 全局点击
  app.onclick = (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'pick') { state.specId = Number(el.dataset.id); location.hash = '#/make'; return; }
    if (act === 'go-make') { location.hash = '#/make'; return; }
    if (act === 'go-suit') { state.mode = 'suit'; location.hash = '#/make'; return; }
    if (act === 'go-bg') { state.mode = 'bg'; location.hash = '#/make'; return; }
    if (act === 'go-print') {
      if (state.cfg?.features?.print === false) {
        toast('冲印下单要接微信支付（config.json 填 mchId），现在先做本地排版导出', 3200);
      }
      location.hash = '#/make';
      setTimeout(() => toast('生成照片后点「排版 6 寸相纸」即可本地排版', 3200), 900);
      return;
    }
    if (act === 'cat') { query = ''; location.hash = '#/specs'; setTimeout(() => toast(`分类「${el.dataset.cat}」已展开`), 60); return; }

    if (act === 'spec') { state.specId = Number(el.dataset.id); state.error = ''; render(); return; }
    if (act === 'mode') { state.mode = el.dataset.mode; state.error = ''; render(); return; }
    if (act === 'suit') { state.suit = el.dataset.id; render(); return; }
    if (act === 'bg') { state.bg = el.dataset.id; render(); return; }

    if (act === 'go-sheet') {
      location.hash = '#/make';
      setTimeout(() => toast('选好照片后点「排版 6 寸相纸」，本地直接导出 1800×1200', 3200), 500);
      return;
    }
    if (act === 'save-key') {
      const v = ($('#apiKeyInput')?.value || '').trim();
      if (!v) return toast('先填 key');
      localStorage.setItem(KEY_STORE, v);
      toast('已保存，刷新状态…');
      refreshStatus();
      render();
      return;
    }
    if (act === 'clear-key') {
      localStorage.removeItem(KEY_STORE);
      toast('已清除 key');
      refreshStatus();
      render();
      return;
    }

    if (act === 'show-orig') { const s = $('#stage'); if (s?.querySelector('img')) s.querySelector('img').src = state.photoUrl; return; }
    if (act === 'show-result') { const s = $('#stage'); if (s?.querySelector('img')) s.querySelector('img').src = state.resultUrl; return; }

    if (act === 'export') { exportSpec(Number(el.dataset.id)); return; }
    if (act === 'sheet') { exportSheet(); return; }
  };

  // 搜索
  const q = $('#q');
  if (q) {
    q.oninput = () => { query = q.value; };
    q.onkeydown = (e) => { if (e.key === 'Enter') { location.hash = '#/specs'; } };
  }
  const q2 = $('#q2');
  if (q2) q2.oninput = () => { query = q2.value; render(); setTimeout(() => { const i = $('#q2'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 0); };

  // 制作页控件
  const file = $('#file');
  if (file) {
    file.onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) return toast('请选择图片文件');
      if (f.size > 20 * 1024 * 1024) return toast('图片太大（>20MB），换一张');
      state.photoUrl = await fileToDataURL(f);
      state.photoImg = await loadImg(state.photoUrl);
      state.resultUrl = ''; state.resultImg = null; state.error = '';
      render();
    };
  }
  const drop = $('#drop');
  if (drop) {
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hover'); };
    drop.ondragleave = () => drop.classList.remove('hover');
    drop.ondrop = async (e) => {
      e.preventDefault(); drop.classList.remove('hover');
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      state.photoUrl = await fileToDataURL(f);
      state.photoImg = await loadImg(state.photoUrl);
      state.resultUrl = ''; state.resultImg = null; state.error = '';
      render();
    };
  }
  const clean = $('#clean');
  if (clean) clean.onchange = () => { state.cleanShave = clean.checked; };
  const hair = $('#hair');
  if (hair) hair.onchange = () => { state.tidyHair = hair.checked; };

  const gen = $('#gen');
  if (gen) gen.onclick = runGenerate;
  const refine = $('#refine');
  if (refine) refine.onclick = runRefine;
}

/* ------------------------------------------------------------------ 生成 */
async function runGenerate() {
  if (!state.photoImg || state.busy) return;
  const spec = findSpec(state.specId);
  const prompt = buildPrompt({
    mode: state.mode, suit: state.suit, bgHex: state.bg,
    cleanShave: state.cleanShave, tidyHair: state.tidyHair,
  });

  state.busy = true;
  state.error = '';
  state.startedAt = Date.now();
  render();

  try {
    const small = downscaleForUpload(state.photoImg, 1280);
    const out = await generate(small, prompt);
    state.resultUrl = out.url;
    state.resultImg = await loadImg(out.url);
    state.lastMs = out.elapsed_ms;
    state.busy = false;
    render();
    toast(`生成完成 · ${(out.elapsed_ms / 1000).toFixed(1)}s`, 2600);
    refreshStatus();
    try {
      const fr = analyzeFraming(state.resultImg);
      if (!fr.headH || fr.headH < state.resultImg.naturalHeight * 0.2) {
        toast('识别到的头像比例偏小，可在导出后手动微调', 3000);
      }
    } catch {}
  } catch (e) {
    state.busy = false;
    state.error = [e.message, e.detail, e.hint].filter(Boolean).join('\n');
    render();
  }
}

async function urlToDataUrl(url) {
  const r = await fetch(url);
  const blob = await r.blob();
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('读取结果图失败'));
    fr.readAsDataURL(blob);
  });
}

/** 第二轮：拿上一版结果当参考图，只做局部精修 */
async function runRefine() {
  if (!state.resultUrl || state.busy) return;
  const prompt = buildRefinePrompt({
    cleanShave: state.cleanShave,
    tidyHair: state.tidyHair,
  });

  state.busy = true;
  state.error = '';
  state.startedAt = Date.now();
  render();

  try {
    const src = state.resultImg
      ? downscaleForUpload(state.resultImg, 1280)
      : await urlToDataUrl(state.resultUrl);
    const out = await generate(src, prompt);
    state.resultUrl = out.url;
    state.resultImg = await loadImg(out.url);
    state.busy = false;
    render();
    toast(`精修完成 · ${(out.elapsed_ms / 1000).toFixed(1)}s`, 2600);
    refreshStatus();
  } catch (e) {
    state.busy = false;
    state.error = [e.message, e.detail, e.hint].filter(Boolean).join('\n');
    render();
  }
}

let ticker = null;function startTicker() {
  clearInterval(ticker);
  ticker = setInterval(() => {
    const bar = $('#bar'), tick = $('#tick');
    if (!bar || !tick) return clearInterval(ticker);
    const s = (Date.now() - state.startedAt) / 1000;
    bar.style.width = Math.min(92, 8 + s * 1.6) + '%';
    tick.textContent = `已用时 ${s.toFixed(0)}s　·　单张 40~90s，号池排队时会久一点`;
  }, 400);
}

/* ------------------------------------------------------------------ 导出 */
async function exportSpec(specId) {
  const spec = findSpec(specId);
  const src = state.resultImg || state.photoImg;
  if (!src) return toast('还没有可导出的照片');

  try {
    const canvas = cropToSpec(src, spec.px);
    const blob = await canvasToJpeg(canvas, { dpi: 300, quality: 0.95 });
    const tag = state.resultImg ? 'AI' : '原图';
    download(blob, `${spec.name}_${spec.px[0]}x${spec.px[1]}_300dpi_${tag}.jpg`);
    toast(`已导出 ${spec.name}（${spec.px[0]}×${spec.px[1]} · 300dpi）`, 2600);
  } catch (e) {
    toast('导出失败：' + e.message, 3000);
  }
}

async function exportSheet() {
  const src = state.resultImg || state.photoImg;
  if (!src) return toast('还没有可排版的照片');
  const spec = SPECS.find((s) => s.id === 1); // 1 寸
  try {
    const single = cropToSpec(src, spec.px);
    const sheet = buildSheet(single, spec.px, { cols: 5, rows: 3 });
    const blob = await canvasToJpeg(sheet, { dpi: 300, quality: 0.95 });
    download(blob, `6寸相纸排版_15张一寸_1800x1200_300dpi.jpg`);
    toast('已导出 6 寸排版（5×3，共 15 张 1 寸）', 2800);
  } catch (e) {
    toast('排版失败：' + e.message, 3000);
  }
}

/* ------------------------------------------------------------------ 启动 */
window.addEventListener('hashchange', render);
loadConfig().then(render);
setInterval(refreshStatus, 20000);
