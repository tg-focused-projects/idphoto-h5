/**
 * 规格 / 正装 / 底色 数据 + 提示词构造
 * 规格数据取自小程序接口 /api/index/hot_spec2、/api/index/spec_detail（px 与 mm 均为官方口径）
 */

export const SPECS = [
  { id: 1, name: '一寸', px: [295, 413], mm: '25×35', cat: '常用', hot: 1, tag: '最常用' },
  { id: 10, name: '二寸', px: [413, 579], mm: '35×49', cat: '常用', hot: 1 },
  { id: 4, name: '小一寸', px: [260, 378], mm: '22×32', cat: '常用', hot: 0 },
  { id: 7, name: '大一寸', px: [390, 567], mm: '33×48', cat: '常用', hot: 0 },
  { id: 10681, name: '大二寸', px: [413, 626], mm: '35×53', cat: '常用', hot: 0 },
  { id: 10675, name: '教资报名', px: [413, 579], mm: '35×49', cat: '考试报名', hot: 1, tag: '白底+深色衣服' },
  { id: 10682, name: '教资面试', px: [413, 579], mm: '35×45', cat: '考试报名', hot: 1 },
  { id: 352, name: '计算机考试', px: [390, 567], mm: '33×48', cat: '考试报名', hot: 1, tag: '请勿戴眼镜' },
  { id: 10677, name: '研究生考试', px: [531, 708], mm: '45×60', cat: '考试报名', hot: 0 },
  { id: 10678, name: '大学生图像采集', px: [480, 640], mm: '41×54', cat: '考试报名', hot: 1 },
  { id: 30, name: '高考报名（5寸）', px: [1050, 1499], mm: '89×127', cat: '考试报名', hot: 0 },
  { id: 10685, name: '健康证', px: [358, 441], mm: '26×32', cat: '证件办理', hot: 0 },
  { id: 61, name: '社保卡', px: [358, 441], mm: '26×32', cat: '证件办理', hot: 0 },
  { id: 62, name: '居住证', px: [358, 441], mm: '26×32', cat: '证件办理', hot: 0 },
  { id: 63, name: '驾照', px: [260, 378], mm: '22×32', cat: '证件办理', hot: 0 },
];

export const CATEGORIES = ['常用', '考试报名', '证件办理'];

/** 底色：与小程序 spec_color 保持同一批色值 */
export const BGS = [
  { id: '438edb', name: '标准蓝', hex: '#438edb' },
  { id: 'ffffff', name: '白色', hex: '#ffffff' },
  { id: 'ff0000', name: '红色', hex: '#ff0000' },
  { id: '20537e', name: '深蓝', hex: '#20537e' },
  { id: 'cce9fc', name: '浅蓝', hex: '#cce9fc' },
  { id: 'a5aabd', name: '灰蓝', hex: '#a5aabd' },
];

export const SUITS = [
  { id: 'black-suit', name: '深色西装（白衬衫+领带）', desc: '深色西装外套，内搭白色衬衫并系深色领带' },
  { id: 'navy-suit', name: '藏青西装（白衬衫+领带）', desc: '藏青色西装外套，内搭白色衬衫并系领带' },
  { id: 'white-shirt', name: '白衬衫（不系领带）', desc: '挺括的白色长袖衬衫，不系领带，领口平整' },
  { id: 'student', name: '学生装（浅色衬衫）', desc: '浅色衬衫配简洁外套，学生气质，不系领带' },
  { id: 'dark-tee', name: '深色有领 T 恤', desc: '深色有领针织衫，简洁无图案' },
];

export const BG_NAME = (hex) => (BGS.find((b) => b.id === hex) || { name: '纯色' }).name;

/**
 * 提示词构造（沿用实测能稳定过审、且保脸的写法）
 *  关键点：
 *   1) 框成"证件照处理"，不要写"换人/不要换人/保持这个人"这类身份强约束词；
 *   2) 明确"五官比例不变 + 保留真实皮肤质感 + 不做美颜"，避免模型把人换掉或磨皮；
 *   3) 一次只改一件事；换装 + 底色可以合并，微调类（胡渣、发型）放第二轮。
 */
export function buildPrompt({ mode, suit, bgHex, cleanShave, tidyHair, extra }) {
  const bg = hexChinese(bgHex);
  const base = [
    '同一张照片的证件照处理',
    `背景替换为纯${bg}，无渐变、无阴影、无纹理`,
    '正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀',
    '五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛',
  ];

  if (mode === 'suit') {
    const s = SUITS.find((x) => x.id === suit) || SUITS[0];
    base.splice(1, 0, `服装换成${s.desc}`);
  } else {
    base.splice(1, 0, '保持人物的服装、发型、面部表情与姿势完全不变');
  }

  if (cleanShave) base.push('上唇与下巴的胡须阴影清理干净，肤色自然、没有胡青');
  if (tidyHair) base.push('发型整理清爽服帖、露出额头，发丝不油腻不翘起');
  if (extra) base.push(String(extra).trim());

  return base.join('；');
}

function hexChinese(hex) {
  const map = {
    '438edb': '蓝色',
    'ffffff': '白色',
    'ff0000': '红色',
    '20537e': '深蓝色',
    'cce9fc': '浅蓝色',
    'a5aabd': '灰蓝色',
  };
  return map[String(hex).toLowerCase()] || '纯色';
}

export const findSpec = (id) => SPECS.find((s) => String(s.id) === String(id)) || SPECS[0];

/**
 * 第二轮「局部精修」提示词
 * 第一轮出图后，胡渣/发丝这类细节常只改掉一半；这时不要重发原图，而是拿**上一版结果**当参考图，
 * 只描述要动的那一两处，并显式锁住其余（背景/服装/五官/构图），避免模型把脸一起重画。
 */
export function buildRefinePrompt({ cleanShave, tidyHair, extra }) {
  const asks = [];
  if (cleanShave) asks.push('把上唇与下巴的胡须阴影彻底清理干净，肤色自然、没有胡青');
  if (tidyHair) asks.push('把两侧头发整理得更服帖整齐，发丝不油腻不翘起');
  if (extra) asks.push(String(extra).trim());
  if (!asks.length) asks.push('把皮肤质感修得更干净自然，保留真实毛孔与细节');

  return [
    '同一张证件照的局部微调',
    asks.join('；'),
    '其他全部保持不变：背景颜色、服装、领带、面部五官与比例、构图与裁切范围',
    '保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛',
  ].join('；');
}
