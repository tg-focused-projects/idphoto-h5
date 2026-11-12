# 证件照 H5（复刻《标准证件照红蓝白》，换正装走本地号池生图）

原小程序的逆向结论（包格式、加密算法、接口面、落地页清单）另存文档，不在本仓库内。
这一份是可直接跑的 **H5 版本**：纯静态前端 + 一个 Node 本地服务，换正装用本机号池的 `gpt-image-2` 做参考图编辑，
构图裁剪 / 底色 / 300dpi / 冲印排版全在浏览器本地完成。

| 首页 | 制作页 |
|---|---|
| ![首页](docs/screenshot-home.png) | ![制作页](docs/screenshot-make.png) |

- 本地打开：**http://127.0.0.1:8000**
- 公网 API：**http://110.40.183.197:8000**（frp 隧道，需要 Bearer key）
- 起服务：`powershell -ExecutionPolicy Bypass -File scripts\start.ps1`（或 `node server.mjs` 只跑本地）
- 生图前提：DSH 在跑（`127.0.0.1:38650` 有 python 进程）+ 代理开着（`127.0.0.1:7890`）

---

## 一、这一版做了什么

| 原小程序 | 这一版 |
|---|---|
| 首页：换正装 / 换底色 / 冲刷实体照 三个入口 | 保留三个入口，第三个改为「排版冲印」（本地 6 寸相纸排版） |
| 规格搜索 + 热门规格 + 分类 | 保留，15 个规格，px/mm/ppi 用官方口径 |
| 拍照页 / 制作页 / 制作中页 / 预览页 | 合并成一页：选图 → 选项 → 生成 → 导出 |
| 云端 AI 换正装（黑盒） | 本机 `gpt-image-2` 参考图编辑，**参数化**：前端传选项，后端拼提示词 |
| 本地换底色（纯色值） | 底色合进同一个生成提示词；另可只裁剪原图导出 |
| 300dpi / 排版 / 打印 | 保留：JPEG 里写真实 300dpi；6 寸相纸 5×3=15 张 1 寸带裁切线 |
| 广告位（mp-ad、adunit banner、插屏） | **全删** |
| 登录 / open_id / 会员 / 点数 / 付费引导弹窗 | **全删**（`config.json` 开关默认 `false`） |
| 微信支付 / iOS 虚拟支付分支 | **全删**（保留 appId / mchId 空位） |

### 删掉的广告与会员部件清单

原包里这些部件在这版里一个都没有：

- `components/mp-ad`（小程序广告位）、各处 `adunit-883eca23713634dd` / `adunit-975231795c0e8cc4`
- 首页与制作页的「广告」角标、插屏广告（`wx.createInterstitialAd`）
- `components/guide-gzh`（关注公众号引导）、`guide-score` / `guide-add`（好评/添加引导）
- `components/popup-recall`（离开召回弹窗）、`popup-coupon`（优惠券弹窗）
- `components/remake-pay-guide` + `callback`（重制付费引导）、`components/ios-pay`、`popup-vip`（会员墙）
- 所有 `statics_pages/point_record`（点数/埋点）与会员价目逻辑

---

## 二、目录

```
h5/
├─ server.mjs              服务：静态站 + 同步/异步 API（参数化 + 原始 prompt 两条路）
├─ router.mjs              可选：一个公网端口分流到两个本地服务（现在 8000 独占，用不到）
├─ config.json             appId / mchId 空位 + 功能开关 + 限流配置（key 不在这里）
├─ api-keys.json           ★ 公网 API 密钥，gitignore，不入库
├─ frpc.toml               frp 隧道：本地 8000 → frps 110.40.183.197:8000
├─ .env.example            FRP_AUTH_TOKEN 模板（复制成 .env）
├─ lib/
│  ├─ prompt.mjs           ★ 参数 → 提示词（前后端共用同一份模板，浏览器也 import 它）
│  └─ jpeg.mjs             PNG→JPEG 压缩（省流量：2MB → 190KB）
├─ public/
│  ├─ index.html           壳 + 底部 tabbar
│  ├─ css/app.css
│  ├─ img/suits/*.jpg      5 套正装的服装预览图（360×360，选衣卡片用）
│  └─ js/
│     ├─ specs.js          15 个规格 + 转出 lib/prompt.mjs 的枚举与构造器
│     ├─ compose.js        构图裁剪（头高 62%、头顶留白 9%）+ JPEG 300dpi + 冲印排版
│     └─ app.js            hash 路由 + 四个视图 + 生成/导出流程
├─ scripts/start.ps1       一键起 8000（公网模式）+ frpc
├─ scripts/start-tunnel.ps1  单独起 frpc（token 从环境变量/.env 注入）
├─ scripts/stop.ps1        停 8000 + frpc
├─ test_generate.mjs       不走浏览器，直接打接口验证后端链路
├─ tools/
│  ├─ public_api_client.mjs  公网客户端：参数化提交 → 轮询 → 取图
│  ├─ param_api_test.mjs     参数化接口自测（sync/async、passes=1/2）
│  ├─ make_suit_previews.mjs 生成 5 套正装的服装预览图（文生图，5 次额度）
│  ├─ cdp_test.mjs           无头 Chrome(CDP) 跑完整 UI 链路
│  ├─ probe_layout.mjs       量视口/grid 轨道，排查横向溢出
│  └─ shot_mobile.mjs        390×844@2x 手机视口截图
└─ outputs/                生成结果落盘（前端只拿 URL）
```

---

## 三、换正装：参数化 + 两轮精修

### 3.1 前端只传参数，后端拼提示词

前端不再拼字符串，只传结构化选项：

```json
{
  "mode": "suit",
  "suit": "black-suit",
  "bg": "438edb",
  "cleanShave": true,
  "tidyHair": false,
  "extra": "",
  "size": "1024x1536",
  "passes": 1
}
```

模板只有一份：`lib/prompt.mjs`。服务端 `import` 它，浏览器也通过 `/lib/prompt.mjs` `import` 它，
所以「界面上选的东西」和「真正发给模型的提示词」永远是同一套逻辑，不会两边各写一份走样。

拼出来是这样（固定骨架 + 变量槽）：

```
同一张照片的证件照处理；
服装换成深色西装外套，内搭白色衬衫并系深色领带；      ← mode/suit
背景替换为纯蓝色，无渐变、无阴影、无纹理；             ← bg
正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀；
五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛；
上唇与下巴的胡须阴影清理干净，肤色自然、没有胡青；      ← cleanShave
发型整理清爽服帖、露出额头，发丝不油腻不翘起；          ← tidyHair
[extra 自由补充]
```

可选值都从 `GET /v1/options` 拿（前端不用把枚举写死）；传了不认识的枚举值直接 400 并列出可选项，不静默降级。

### 3.2 正装预览图（选衣卡片）

5 套服装各有一张 360×360 的服装图，放在 `public/img/suits/<suit-id>.jpg`，
界面上做成可点的卡片（选中态蓝框 + 蓝色标签），`GET /v1/options` 返回的 `suits[]` 里也带 `preview` 字段。

重新生成（换了款式/想换风格时）：

```bash
node tools/make_suit_previews.mjs      # 文生图，5 张 = 5 次额度
```

提示词是「服装电商产品图，正面平铺，浅灰纯色背景，无模特」，所以是**衣服图**不是人像图——
既不会涉及肖像，也不用担心 5 张里的人长得不一样。

### 3.3 提示词要点（实测能过审、且保脸）
1. **框成「证件照处理」**，别写「保持这个人不变 / 不要换人」——身份强约束会触发上游内容策略。
2. **必须写「五官比例与本人一致 / 保留真实皮肤质感 / 不做美颜」**，否则模型会顺手磨皮瘦脸。
3. **一次只改一类事**；换装 + 底色可以合并，「局部微调」（胡渣、发丝）留给第二轮。

### 3.4 第二轮「局部精修」

`passes: 2` 时后端自动跑两轮：第一轮出图，第二轮拿**第一轮结果**当参考图，只描述要动的一两处，
并显式锁住其余：

```
同一张证件照的局部微调；
把上唇与下巴的胡须阴影彻底清理干净，肤色自然、没有胡青；
其他全部保持不变：背景颜色、服装、领带、面部五官与比例、构图与裁切范围；
保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛
```

也可以在已有结果上单独触发（`refineOnly: true`，界面上的「局部精修」按钮就是这个）。

实测：第一轮 41.8s、第二轮 46.8s，胡渣基本清干净；代价是磨皮感略增，要求「原始肤质」就停在第一轮。

### 3.5 出图之后的本地处理（`compose.js`）

1. `analyzeFraming()`：缩到 240px 宽，用左上角像素当背景色，主体 = 与背景距离 > 60 的像素；
   第一行主体像素够多 = 发顶；眼鼻一带的水平质心 = 人脸中心。
2. `cropToSpec()`：`头高 = 下巴 - 发顶`，`cropH = 头高 / 0.62`，`cropW = cropH × 规格宽高比`，
   `top = 发顶 - 0.09 × cropH`，按人脸中心水平居中 → 画到 `spec.px` 尺寸。
3. `patchJpegDpi()`：往 JPEG 的 JFIF APP0 写 `units=1, X=300, Y=300`（浏览器 canvas 默认 72dpi，
   报名系统会按 72dpi 算物理尺寸）。
4. `buildSheet()`：6 寸相纸 1800×1200，5×3 排 1 寸，带 1px 裁切参考线。

---

## 四、公网 API

本机这套服务挂在自己的 frps 上（跟原来 ComfyUI/Qwen 生图接口同一套做法）：

```
公网 base：http://110.40.183.197:8000
鉴权     ：Authorization: Bearer <api-keys.json 里的 key>
本地 H5  ：http://127.0.0.1:8000
```

接口形状照 ComfyUI 的 `POST /prompt` → `GET /history/{id}` → `GET /view?filename=`：
**提交任务 → 轮询 → 取图**。单张 40~90s，公网长连接容易被中间设备掐断，异步比同步稳。

### 4.1 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/options` | 可选值：modes / suits / bgs / sizes / defaults |
| POST | `/v1/idphoto` | **参数化提交**，`202 {job_id, poll_url, params, params_summary, prompt}` |
| POST | `/api/idphoto` | 参数化同步版（本机 H5 用，公网模式下也要 key） |
| GET | `/v1/jobs/{id}` | 任务状态；结构化任务回显 `params` / `params_summary` / `prompt` |
| GET | `/files/{name}` | 取图（`result.url` PNG / `result.jpeg_url` 压缩版，**不需要 key**） |
| GET | `/api/health` | 后端在线 + 号池额度 + 限流档位 |
| POST | `/v1/jobs` | 原始 prompt 版（要完全自定义提示词时用） |

参数化提交体：

```json
{
  "image": "data:image/jpeg;base64,...",
  "params": {
    "mode": "suit",
    "suit": "black-suit",
    "bg": "438edb",
    "cleanShave": true,
    "tidyHair": false,
    "extra": "",
    "size": "1024x1536",
    "passes": 1
  }
}
```

查询结果：

```json
{
  "ok": true, "job_id": "job_xxx", "status": "succeeded", "elapsed_ms": 73000,
  "params": { "mode": "suit", "suit": "black-suit", "bg": "438edb" },
  "params_summary": "换正装(深色西装（白衬衫+领带）) · 底色 标准蓝 #438edb · 清胡渣",
  "prompt": "同一张照片的证件照处理；服装换成深色西装外套…",
  "result": {
    "url": "http://110.40.183.197:8000/files/xxx.png", "bytes": 2017819,
    "jpeg_url": "http://110.40.183.197:8000/files/xxx.jpg", "jpeg_bytes": 161792,
    "first_pass_url": "http://.../files/yyy.png"
  }
}
```

### 4.2 参数表

| 参数 | 类型 | 默认 | 取值 |
|---|---|---|---|
| `mode` | string | `suit` | `suit` 换正装 / `bg` 只换底色 |
| `suit` | string | `black-suit` | `black-suit` / `navy-suit` / `white-shirt` / `student` / `dark-tee` |
| `bg` | string | `438edb` | `438edb` 蓝 / `ffffff` 白 / `ff0000` 红 / `20537e` 深蓝 / `cce9fc` 浅蓝 / `a5aabd` 灰蓝 |
| `cleanShave` | bool | `true` | 清理胡渣 |
| `tidyHair` | bool | `false` | 整理发型 |
| `extra` | string | `""` | 自由补充，≤300 字 |
| `size` | string | `1024x1536` | `1024x1536` / `1024x1024` / `1536x1024` |
| `passes` | number | `1` | `1` 一轮；`2` 出图后自动精修一轮（多消耗 1 次额度） |
| `refineOnly` | bool | `false` | 只精修（拿传入图当参考图，走精修模板） |

### 4.3 现成客户端

```bash
# 参数化（推荐）
node tools/public_api_client.mjs <照片> http://110.40.183.197:8000 <key>

# 参数化接口自测（sync / async，passes=1/2）
node tools/param_api_test.mjs <照片> http://110.40.183.197:8000 <key> async 2
```

### 4.4 限流

| 档 | 默认 | 配置项 |
|---|---|---|
| 生成 | 6 次/分钟，80 次/天 | `config.json → api.rateLimit.perMinute / perDay` |
| 轮询/取图 | 120 次/分钟 | `config.json → api.rateLimit.pollPerMinute` |

轮询单独一档：客户端每 3s 查一次，跟生成抢额度会把自己限死（这个坑实测踩过）。
`passes: 2` 的请求按 1 次计限流、但实际消耗 2 次号池额度。

### 4.5 鉴权模式

| 模式 | 触发 | 行为 |
|---|---|---|
| 本机同源 | 默认 | `/api/*`、`/v1/*` 免 key |
| 公网 | `IDPHOTO_PUBLIC=1` 或 `config.json → api.public=true` | **所有** `/api/*`、`/v1/*` 必须 Bearer；`/files/*` 与静态页开放 |

公网部署时 H5 的「我的」页有 **API Key** 输入框，填一次存 localStorage，之后页面自己带 `Authorization`。

### 4.6 为什么是 8000 + frp

本机 frps（`110.40.183.197:7000`）实测**只放行 remotePort 8000**（试过 8001/8080/8091/9000 全部 `port not allowed`）。
原来 8000 是 Qwen 生图 API 的，现在那套不用了，8000 直接给本项目：

```toml
serverAddr = "110.40.183.197"
serverPort = 7000
auth.token = "{{ .Envs.FRP_AUTH_TOKEN }}"
transport.tls.enable = true

[[proxies]]
name = "idphoto-api"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8000
remotePort = 8000
```

token 不写死：`scripts/start-tunnel.ps1` 按「环境变量 → `h5/.env` → `D:\Qwen-Image-Edit-2511\.env`」找 `FRP_AUTH_TOKEN`。

### 4.7 起停

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1          # 8000（公网模式）+ frpc
powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1   # 只起隧道
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1           # 停 8000 + frpc
```

### 4.8 密钥

- 只存在 `api-keys.json`（**已 gitignore**，支持多把：`{"keys":["sk-...","sk-..."]}`），或环境变量 `IDPHOTO_API_KEYS`。
- 换 key：改文件 → 重启 `server.mjs`。
- 仓库里不含任何 key；`config.json` 只有限流和 CORS 配置。

---

## 五、验证记录（本机实跑）

### 5.1 真实自拍（1080×1920，室内杂背景，有胡渣）

| 步骤 | 结果 | 耗时 |
|---|---|---|
| 第一轮 换装+换底 | 深色西装 + 白衬衫 + 藏青领带 + 纯蓝底，五官/发际线保留 | 41.8s |
| 第二轮 局部精修 | 上唇胡表阴影基本清干净、两侧发丝更服帖 | 46.8s |
| 导出 一寸 | 295×413，dpi 300,300 | — |
| 导出 二寸 | 413×579，dpi 300,300 | — |
| 导出 6 寸排版 | 1800×1200，15 张 1 寸带裁切线 | — |

### 5.2 参数化接口（新）

| 用例 | 结果 |
|---|---|
| `POST /api/idphoto`（sync，passes=1，本机） | 200，36.2s，回显 `params_summary` / `prompt` |
| `POST /v1/idphoto`（async，passes=2，走公网 frp） | 73.0s，`first_pass_url` + `refine_prompt` 都回显 |
| `GET /v1/options` | 枚举齐全（2 modes / 5 suits / 6 bgs / 3 sizes） |
| 传非法枚举 | 400，错误里列出可选值 |
| H5 页面（浏览器） | 5 个正装按钮、6 个底色、无 JS 错误；填 key 后号池额度正常显示 |

### 5.3 带宽

| 通道 | 同一张 2MB PNG |
|---|---|
| ngrok 免费 | 30 KB/s → 52s |
| frp 到自己服务器 | 695 KB/s → 3.0s |

---

## 六、接自己的 AppID / 商户号

全在 `config.json`，当前一律留空、功能开关全关：

```json
{
  "features": { "login": false, "vip": false, "ads": false, "payment": false, "print": false },
  "wechat":  { "appId": "", "mchId": "" }
}
```

接自己的号时分三步：

1. 填 `wechat.appId` / `wechat.mchId`。
2. 服务端补两个接口（路由名已留）：`wechat.jsapiTicketEndpoint`（算 `wx.config` 签名）、`wechat.payEndpoint`（JSAPI 下单 + 回调）。
3. 想开哪个功能就把 `features` 里对应项改成 `true`，前端已按开关渲染（`我的` 页会显示已禁用/已启用）。

---

## 七、已知限制

**公网相关**

- `/files/*` 不需要 key：结果图靠「时间戳 + 8 位随机 hex」当口令，拿到 URL 就能下。
  正式对外开放前建议改成签名 URL（HMAC + 过期时间），或者取图也套 Bearer。
- `outputs/` 不会自动清理：一张 2MB，跑多了会堆。生产上定时清或直接落对象存储（OSS/COS/S3）。
- 任务表在单实例内存里：`/v1/jobs` 的记录重启即丢（结果文件还在）。要多实例得换 Redis。
- 带宽：frp 到自己服务器实测 ~700KB/s，够用；换 ngrok 免费通道会掉到 ~30KB/s（那才必须靠 JPEG 兜）。

**产品相关**

1. 单张一次生成：改底色/换装都要重新出图（1 次额度）。省额度可以走「只裁剪原图导出」。
2. 模型偏好长构图：`1024x1536` 是最接近证件照比例的竖图尺寸；再方的尺寸它会自己补背景。
3. 不做美颜：提示词明确禁了美颜；想好看点就把最后一句改成中性描述（但会影响「真实」）。
4. 构图依赖背景干净：`analyzeFraming` 用左上角像素当背景色，纯色底成片没问题；
   用户上传复杂背景原片又直接裁剪的话，要先走一次 AI 换底色。
5. 没有服务端历史/订单：`outputs/` 只是本次生成的文件，没有列表页。
