# 证件照 H5（复刻《标准证件照红蓝白》，换正装走 chatgpt2api 生图）

原小程序的逆向结论见上级目录 `证件照小程序_逆向与换正装复刻.md`。
这一份是可直接跑的 **H5 版本**：纯静态前端 + 一个 Node 本地服务，换正装用本机号池的 `gpt-image-2` 做参考图编辑，
构图裁剪 / 底色 / 300dpi / 冲印排版全在浏览器本地完成。

- 打开地址：**http://127.0.0.1:8088**
- 起服务：`node server.mjs`（或 `npm start`）
- 生图前提：DSH 在跑（`127.0.0.1:38650` 有 python 进程）+ 代理开着（`127.0.0.1:7890`）

---

## 一、这一版做了什么

| 原小程序 | 这一版 |
|---|---|
| 首页：换正装 / 换底色 / 冲刷实体照 三个入口 | 保留三个入口，第三个改为「排版冲印」（本地 6 寸相纸排版） |
| 规格搜索 + 热门规格 + 分类 | 保留，15 个规格，px/mm/ppi 用官方口径 |
| 拍照页 / 制作页 / 制作中页 / 预览页 | 合并成一页：选图 → 选项 → 生成 → 导出 |
| 云端 AI 换正装（黑盒） | **本机 chatgpt2api `gpt-image-2` 参考图编辑**，提示词可控、可复现 |
| 本地换底色（纯色值） | 保留，底色合进同一个生成提示词（一步出图），另可只裁剪原图导出 |
| 300dpi / 排版 / 打印 | 保留：JPEG 里写真实 300dpi；6 寸相纸 5×3=15 张 1 寸带裁切线 |
| 广告位（mp-ad×N、adunit banner、插屏） | **全删** |
| 登录 / open_id / 会员 / 点数 / 付费引导弹窗 | **全删**（`config.json` 里开关默认 `false`） |
| 微信支付 / iOS 虚拟支付分支 | **全删**（保留 appId / mchId 空位） |

### 删掉的广告与会员部件清单

原包里这些部件在这版里一个都没有：

- `components/mp-ad`（小程序广告位）、各处 `adunit-883eca23713634dd` / `adunit-975231795c0e8cc4`
- 首页与制作页的「广告」角标、插屏广告（`wx.createInterstitialAd`）
- `components/guide-gzh`（关注公众号引导）、`guide-score` / `guide-add`（好评/添加引导）
- `components/popup-recall`（离开召回弹窗）、`popup-coupon`（优惠券弹窗）
- `components/remake-pay-guide` + `callback`（重制付费引导）、`components/ios-pay`、`popup-vip`（会员墙）
- 所有 `wx.request` 里的 `statics_pages/point_record`（点数/埋点）与会员价目逻辑

现在页面里没有任何第三方广告脚本、没有弹窗召回、没有付费墙，打开就能生成。

---

## 二、目录

```
h5/
├─ server.mjs              本地服务：静态站 + /api/generate 代理（admin key 只在服务端）
├─ config.json             appId / mchId 空位 + 功能开关（login/vip/payment/ads/print 全 false）
├─ public/
│  ├─ index.html           壳 + 底部 tabbar
│  ├─ css/app.css
│  └─ js/
│     ├─ specs.js          15 个规格 / 6 种底色 / 5 套正装 / 提示词构造
│     ├─ compose.js        构图裁剪（头高 62%、头顶留白 9%）+ JPEG 300dpi + 冲印排版
│     └─ app.js            hash 路由 + 四个视图 + 生成/导出流程
├─ test_generate.mjs       不走浏览器，直接打 /api/generate 验证后端链路
├─ tools/
│  ├─ cdp_test.mjs         无头 Chrome(CDP) 跑完整链路：选图→生成→截图→导出→校验
│  ├─ probe_layout.mjs     量视口/grid 轨道，排查横向溢出
│  └─ shot_mobile.mjs      390×844@2x 手机视口截图
└─ outputs/                生成结果落盘（前端只拿 URL）
```

---

## 三、换正装是怎么实现的（参考 session-ee201ec6 的做法）

一条 `POST /api/generate` 走完，服务端把它翻译成 chatgpt2api 的参考图编辑：

```
POST http://127.0.0.1:38650/v1/images/edits
Authorization: Bearer <~/.dsh/chatgpt2api-native/admin-key>
{
  "model": "gpt-image-2",
  "prompt": "…",
  "n": 1,
  "response_format": "b64_json",
  "size": "1024x1536",
  "images": [{ "b64_json": "<照片>", "mime_type": "image/jpeg", "filename": "reference-1.jpg" }]
}
```

`server.mjs` 里把超时放到 **420s**（默认 240s 在号池排队时必挂，这是上个会话踩过的坑），
结果落盘 `outputs/`，只把 `/outputs/xxx.png` 的 URL 回给前端。

### 提示词（`public/js/specs.js: buildPrompt`）

三段固定 + 两个可选，都是上个会话实测能过审、且保脸的写法：

```
同一张照片的证件照处理；
[服装换成深色西装外套，内搭白色衬衫并系深色领带]；   ← 换装模式才有
背景替换为纯蓝色，无渐变、无阴影、无纹理；
正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀；
五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛；
[上唇与下巴的胡须阴影清理干净，肤色自然、没有胡青]；  ← 勾了“清理胡渣”
[发型整理清爽服帖、露出额头，发丝不油腻不翘起]        ← 勾了“整理发型”
```

要点（照抄原会话的经验）：

1. **框成「证件照处理」**，别写「保持这个人不变 / 不要换人」——身份强约束会触发上游内容策略。
2. **必须写「五官比例与本人一致 / 保留真实皮肤质感 / 不做美颜」**，否则模型会顺手磨皮瘦脸。
3. **一次只改一类事**；换装 + 底色可以合并，但「局部微调」（胡渣、发丝）留给第二轮，避免脸被一起改掉。
4. 单张 40~90s 是正常值；号池被别的任务占用时会到 100s+。

### 第二轮「局部精修」（`buildRefinePrompt`）

出图后点「局部精修」，前端拿**上一版结果**（不是原图）当参考图再发一次，提示词只描述要动的那一两处：

```
同一张证件照的局部微调；
把上唇与下巴的胡须阴影彻底清理干净，肤色自然、没有胡青；把两侧头发整理得更服帖整齐；
其他全部保持不变：背景颜色、服装、领带、面部五官与比例、构图与裁切范围；
保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛
```

关键：**锁住「其余不变」**。实测第一轮 41.8s、第二轮 46.8s，胡表阴影基本清干净。

### 出图之后的本地处理（`compose.js`）

1. `analyzeFraming()`：把图缩到 240px 宽，用左上角像素当背景色，主体=与背景距离>60 的像素；
   第一行主体像素够多的位置 = 发顶；眼鼻一带的水平质心 = 人脸中心。
2. `cropToSpec()`：`头高 = 下巴-发顶`，`cropH = 头高 / 0.62`，`cropW = cropH × 规格宽高比`，
   `top = 发顶 - 0.09 × cropH`，按人脸中心水平居中 → 直接画到 `spec.px` 尺寸。
3. `patchJpegDpi()`：往 JPEG 的 JFIF APP0 里写 `units=1, X=300, Y=300`。
   浏览器 canvas 导出默认是 72dpi，报名系统会按 72dpi 算物理尺寸，必须补这一步。
4. `buildSheet()`：6 寸相纸 1800×1200，5×3 排 1 寸，带 1px 裁切参考线。

---

## 四、验证过的结果（本机实跑）

| 项 | 结果 |
|---|---|
| `/api/status` | `reachable:true, active:9, quota:202`（本轮共消耗 2 次额度） |
| 直接打接口（`test_generate.mjs`） | **36.0s** 出图 1.6MB，蓝底 + 深色西装 + 白衬衫 + 领带 |
| 浏览器全链路（`tools/cdp_test.mjs`） | 选图 OK → 生成 **61.9s** → 截图 → 导出下载 OK |
| 导出文件 | `一寸_295x413_300dpi_AI.jpg`，**295×413 px，DPI (300,300)**，20KB |
| 构图自检 | `hairTop=230, headH=845, cx=510`（原图 1024×1536） |
| 前端 `analyzeFraming` + `cropToSpec` + DPI 补丁 | JFIF 校验通过，`dpiUnits=1, dpiX=300, dpiY=300` |
| 交互回归 | 「换正装 ⇄ 只换底色」切换后按钮文案/正装区块/底色选中态均正确，无横向溢出（390×844 下 `scrollWidth=390`） |

### 真实自拍实测（1080×1920，室内杂背景，有胡渣）

`node tools/cdp_test.mjs "<照片>" real2 refine` —— 两轮法，全程浏览器操作：

| 步骤 | 结果 | 耗时 |
|---|---|---|
| 第一轮 换装+换底 | 深色西装 + 白衬衫 + 藏青领带 + 纯蓝底，五官/脸型/发际线保留 | **41.8s** |
| 第二轮 局部精修（以第一轮结果为参考图） | 上唇胡表阴影基本清干净、两侧发丝更服帖 | **46.8s** |
| 构图自检 | `hairTop=213, headH=845, cx=508`（源图 1024×1536） | — |
| 导出 一寸 | `295×413`，dpi `300,300`，30KB | — |
| 导出 二寸 | `413×579`，dpi `300,300`，52KB | — |
| 导出 6 寸排版 | `1800×1200`，dpi `300,300`，15 张 1 寸带裁切线 | — |

合计消耗 **2 次号池额度**（剩余 186）。对比图：`../out/h5-test-compare.jpg`。

结论：一轮就能出可用证件照；胡渣/发丝这类细节建议走第二轮精修，且**第二轮必须拿第一轮结果当参考图**，
否则模型会连脸一起重画。第二轮会稍微增加磨皮感，如果报名系统要求"原始肤质"，就到第一轮为止。

界面截图：`../out/h5-home.png`、`../out/h5-make-result.png`（生成结果页）、`../out/h5-mobile-home.png`、`../out/h5-mobile.png`、`../out/h5-mobile-mine.png`；
出图样例：`../out/h5-result-suit-438edb.png`、`../out/h5-browser-result.png`、`../out/h5-export-1inch.jpg`（可直接投报名系统）。

---

## 五、接自己的 AppID / 商户号

全在 `config.json`，当前一律留空、功能开关全关：

```json
{
  "features": { "login": false, "vip": false, "ads": false, "payment": false, "print": false },
  "wechat":  { "appId": "", "mchId": "" }
}
```

接自己的号时分三步：

1. 填 `wechat.appId` / `wechat.mchId`。
2. 服务端补两个接口（`server.mjs` 里已留路由名）：
   - `wechat.jsapiTicketEndpoint`：拿 `access_token` → `jsapi_ticket` → 给前端算 `wx.config` 签名；
   - `wechat.payEndpoint`：`JSAPI 下单`（`/v3/pay/transactions/jsapi`）+ 支付结果回调。
3. 想开哪个功能就把 `features` 里对应项改成 `true`，前端已按开关渲染（`我的` 页会显示「已禁用/已启用」）。

**注意**：`/api/generate` 现在没有任何鉴权与配额控制，只监听 `127.0.0.1`。
如果要放到公网（公众号 H5 / 小程序 web-view），至少先做三件事：
① 服务端加会话/频率限制（否则等于把号池送人）；② 图片上传落盘别落成公开目录；
③ 把 `outputs/` 的访问加签名或改成反向代理内部路径。

---

## 六、已知限制

1. **单张一次生成**：一张照片一次调用，改底色/换装都要重新出图（1 次额度）。想省额度可以走「只裁剪原图导出」。
2. **模型偏好长构图**：`1024x1536` 是竖图里最接近证件照比例的；再方的尺寸它会自己补背景。
3. **不做美颜**：提示词明确禁了美颜。如果用户想要好看点的，把最后一句改成中性描述即可（但会影响"真实"）。
4. **构图依赖背景干净**：`analyzeFraming` 用左上角像素当背景色，纯色底成片没问题；
   如果用户上传的是复杂背景原片又直接裁剪，要先走一次 AI 换底色。
5. **没有服务端历史/订单**：`outputs/` 只是本次生成的文件，重启服务不会清，但没有列表页。
