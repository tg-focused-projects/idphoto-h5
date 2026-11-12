/**
 * 参数 → 提示词（前后端共用的唯一一份模板）
 * ============================================================
 * 浏览器和小程序都能 import（纯 ESM，无 Node API），服务端也 import 这个文件，
 * 保证「前端选的选项」和「后端拼出来的 prompt」永远是同一套逻辑，不会两边各写一份走样。
 *
 * 对外就两件事：
 *   normalizeParams(raw)  → { ok, params, error }   校验并补默认值
 *   buildPrompt(params)   → string                  拼提示词
 */

export const MODES = [
  { id: 'suit', name: '换正装', desc: '换衣服 + 换底色' },
  { id: 'bg', name: '只换底色', desc: '衣服发型不动，只换背景' },
];

export const SUITS = [
  { id: 'black-suit', name: '深色西装（白衬衫+领带）', short: '深色西装', desc: '深色西装外套，内搭白色衬衫并系深色领带', preview: '/img/suits/black-suit.jpg' },
  { id: 'navy-suit', name: '藏青西装（白衬衫+领带）', short: '藏青西装', desc: '藏青色西装外套，内搭白色衬衫并系领带', preview: '/img/suits/navy-suit.jpg' },
  { id: 'white-shirt', name: '白衬衫（不系领带）', short: '白衬衫', desc: '挺括的白色长袖衬衫，不系领带，领口平整', preview: '/img/suits/white-shirt.jpg' },
  { id: 'student', name: '学生装（浅色衬衫）', short: '学生装', desc: '浅色衬衫配简洁外套，学生气质，不系领带', preview: '/img/suits/student.jpg' },
  { id: 'dark-tee', name: '深色有领 T 恤', short: '深色T恤', desc: '深色有领针织衫，简洁无图案', preview: '/img/suits/dark-tee.jpg' },
];

export const BGS = [
  { id: '438edb', name: '标准蓝', hex: '#438edb', cn: '蓝色' },
  { id: 'ffffff', name: '白色', hex: '#ffffff', cn: '白色' },
  { id: 'ff0000', name: '红色', hex: '#ff0000', cn: '红色' },
  { id: '20537e', name: '深蓝', hex: '#20537e', cn: '深蓝色' },
  { id: 'cce9fc', name: '浅蓝', hex: '#cce9fc', cn: '浅蓝色' },
  { id: 'a5aabd', name: '灰蓝', hex: '#a5aabd', cn: '灰蓝色' },
];

export const SIZES = ['1024x1536', '1024x1024', '1536x1024'];

export const DEFAULTS = {
  mode: 'suit',
  suit: 'black-suit',
  bg: '438edb',
  cleanShave: true,
  tidyHair: false,
  extra: '',
  size: '1024x1536',
  passes: 1,
  refineOnly: false,
};

const bgOf = (id) => BGS.find((b) => b.id === String(id || '').toLowerCase());
const suitOf = (id) => SUITS.find((s) => s.id === String(id || ''));

/** 把前端传的裸参数校验成规范参数；不认识的值直接报错，别静默降级 */
export function normalizeParams(raw = {}) {
  const p = { ...DEFAULTS };
  const src = raw.params && typeof raw.params === 'object' ? { ...raw, ...raw.params } : raw;

  if (src.mode !== undefined) {
    if (!MODES.some((m) => m.id === src.mode)) {
      return { ok: false, error: `mode 不支持：${src.mode}，可选 ${MODES.map((m) => m.id).join(' / ')}` };
    }
    p.mode = src.mode;
  }
  if (src.suit !== undefined) {
    if (!suitOf(src.suit)) {
      return { ok: false, error: `suit 不支持：${src.suit}，可选 ${SUITS.map((s) => s.id).join(' / ')}` };
    }
    p.suit = src.suit;
  }
  if (src.bg !== undefined) {
    const b = bgOf(src.bg);
    if (!b) return { ok: false, error: `bg 不支持：${src.bg}，可选 ${BGS.map((b) => b.id).join(' / ')}` };
    p.bg = b.id;
  }
  if (src.size !== undefined) {
    if (!SIZES.includes(src.size)) return { ok: false, error: `size 不支持：${src.size}，可选 ${SIZES.join(' / ')}` };
    p.size = src.size;
  }
  if (src.cleanShave !== undefined) p.cleanShave = !!src.cleanShave;
  if (src.tidyHair !== undefined) p.tidyHair = !!src.tidyHair;
  if (src.extra !== undefined) {
    const extra = String(src.extra).trim();
    if (extra.length > 300) return { ok: false, error: 'extra 最长 300 字' };
    p.extra = extra;
  }
  if (src.passes !== undefined) {
    const n = Number(src.passes);
    if (![1, 2].includes(n)) return { ok: false, error: 'passes 只能是 1 或 2（2 = 出图后再自动精修一轮，多消耗 1 次额度）' };
    p.passes = n;
  }
  if (src.refineOnly !== undefined) {
    p.refineOnly = !!src.refineOnly;
    if (p.refineOnly) p.passes = 1;   // 只精修，不再叠加第二轮
  }
  return { ok: true, params: p };
}

/**
 * 第一轮提示词
 *  关键点：
 *   1) 框成「证件照处理」，不要写「换人 / 不要换人 / 保持这个人」这类身份强约束词；
 *   2) 明确「五官比例一致 + 保留真实皮肤质感 + 不做美颜」，否则模型会顺手磨皮瘦脸；
 *   3) 一次只改一类事；换装+底色可合并，微调（胡渣、发丝）放第二轮。
 */
export function buildPrompt(params) {
  const p = { ...DEFAULTS, ...params };
  const bg = (bgOf(p.bg) || BGS[0]).cn;
  const parts = ['同一张照片的证件照处理'];

  if (p.mode === 'suit') {
    const s = suitOf(p.suit) || SUITS[0];
    parts.push(`服装换成${s.desc}`);
  } else {
    parts.push('保持人物的服装、发型、面部表情与姿势完全不变');
  }

  parts.push(`背景替换为纯${bg}，无渐变、无阴影、无纹理`);
  parts.push('正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀');
  parts.push('五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛');

  if (p.cleanShave) parts.push('上唇与下巴的胡须阴影清理干净，肤色自然、没有胡青');
  if (p.tidyHair) parts.push('发型整理清爽服帖、露出额头，发丝不油腻不翘起');
  if (p.extra) parts.push(p.extra);

  return parts.join('；');
}

/**
 * 第二轮「局部精修」提示词：拿第一轮结果当参考图，只描述要动的一两处，
 * 并显式锁住其余，避免模型把脸一起重画。
 */
export function buildRefinePrompt(params) {
  const p = { ...DEFAULTS, ...params };
  const asks = [];
  if (p.cleanShave) asks.push('把上唇与下巴的胡须阴影彻底清理干净，肤色自然、没有胡青');
  if (p.tidyHair) asks.push('把两侧头发整理得更服帖整齐，发丝不油腻不翘起');
  if (p.extra) asks.push(p.extra);
  if (!asks.length) asks.push('把皮肤质感修得更干净自然，保留真实毛孔与细节');

  return [
    '同一张证件照的局部微调',
    asks.join('；'),
    '其他全部保持不变：背景颜色、服装、领带、面部五官与比例、构图与裁切范围',
    '保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛',
  ].join('；');
}

/** 参数的中文摘要，写进任务记录方便排查 */
export function describeParams(params) {
  const p = { ...DEFAULTS, ...params };
  const bg = bgOf(p.bg) || BGS[0];
  const suit = suitOf(p.suit);
  const bits = [p.refineOnly ? '局部精修' : (p.mode === 'suit' ? `换正装(${suit ? suit.name : p.suit})` : '只换底色'), `底色 ${bg.name} ${bg.hex}`];
  if (p.cleanShave) bits.push('清胡渣');
  if (p.tidyHair) bits.push('整理发型');
  if (p.extra) bits.push(`补充:${p.extra.slice(0, 20)}`);
  if (p.passes === 2) bits.push('两轮精修');
  return bits.join(' · ');
}
