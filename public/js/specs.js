/**
 * 规格 / 底色 / 正装 数据 + 提示词构造
 * ------------------------------------------------------------
 * 提示词模板和枚举都搬到了 lib/prompt.mjs（前后端共用同一份，避免两边走样），
 * 这里只做转出 + 规格表。
 */

import {
  MODES, SUITS, BGS, SIZES, DEFAULTS,
  normalizeParams, buildPrompt, buildRefinePrompt, describeParams,
} from '/lib/prompt.mjs';

export {
  MODES, SUITS, BGS, SIZES, DEFAULTS,
  normalizeParams, buildPrompt, buildRefinePrompt, describeParams,
};

/** 规格数据取自小程序接口 /api/index/hot_spec2、/api/index/spec_detail（px 与 mm 均为官方口径） */
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

export const findSpec = (id) => SPECS.find((s) => String(s.id) === String(id)) || SPECS[0];

export const BG_NAME = (hex) => (BGS.find((b) => b.id === String(hex).toLowerCase()) || { name: '纯色' }).name;
