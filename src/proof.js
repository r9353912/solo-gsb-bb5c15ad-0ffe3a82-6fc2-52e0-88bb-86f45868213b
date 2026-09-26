'use strict';

/**
 * 双面打样 HTML 导出。
 *
 * 打样固定为 A4 横向（297mm × 210mm），每张纸的正反两面各占一页，
 * 依帖号和帖内纸张顺序排列（单帖模式视为唯一一帖），每张纸先正面后背面，
 * 配合浏览器「双面 · 短边翻转」打印即可得到正反对应的实体打样：
 * 背面左右版位相对正面镜像排布（背面左版内容落在正面右版的背面），文字保持正向。
 *
 * 每面标出：左右版位页码（或空白版位）、中央折线（含上下折线标记）与四角对位标。
 * 启用爬移补偿时，仅页码内容按该纸张的补偿量（mm）朝折线平移
 * （左版 +c 向右、右版 −c 向左，正反两面一致），对位标与折线保持原位。
 *
 * 导出前服务端须经 validateImposition 校验通过；本函数与 buildCsv 一样
 * 只对结构合法性负责：结构非法（含爬移补偿数据被篡改）返回 null。
 */

const { normalizeState } = require('./imposition');

const SIDE_LABEL = { front: '正面', back: '反面' };
const POS_LABEL = { left: '左版', right: '右版' };
const PRINT_NOTE = 'A4 横向 · 按 100% 比例打印 · 双面打印（短边翻转）· 背面版位与正面镜像对应';

const PROOF_CSS = `
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #000; }
.proof-page { position: relative; width: 297mm; height: 210mm; overflow: hidden; background: #fff; page-break-after: always; break-after: page; }
.proof-page:last-child { page-break-after: auto; break-after: auto; }
.reg { position: absolute; }
.reg.tl { left: 8mm; top: 8mm; }
.reg.tr { right: 8mm; top: 8mm; }
.reg.bl { left: 8mm; bottom: 8mm; }
.reg.br { right: 8mm; bottom: 8mm; }
.fold { position: absolute; left: 148.5mm; top: 8mm; bottom: 8mm; border-left: 0.3mm dashed #555; }
.fold-tick { position: absolute; left: 146.5mm; width: 0; height: 0; border-left: 2mm solid transparent; border-right: 2mm solid transparent; }
.fold-tick.top { top: 0; border-top: 3mm solid #555; }
.fold-tick.bottom { bottom: 0; border-bottom: 3mm solid #555; }
.fold-label { position: absolute; left: 148.5mm; top: 10mm; transform: translateX(-50%); padding: 0 1.5mm; background: #fff; font-size: 8pt; color: #555; }
.meta { position: absolute; left: 20mm; top: 10mm; font-size: 9pt; }
.print-note { position: absolute; right: 20mm; top: 10mm; font-size: 7.5pt; color: #555; }
.slot { position: absolute; top: 0; bottom: 0; width: 148.5mm; }
.slot.left { left: 0; }
.slot.right { left: 148.5mm; }
.trim { position: absolute; left: 14mm; right: 14mm; top: 18mm; bottom: 14mm; border: 0.25mm dashed #bbb; }
.slot-tag { position: absolute; left: 0; top: 21mm; width: 100%; text-align: center; font-size: 8pt; color: #777; }
.content { position: absolute; left: 0; right: 0; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center; }
.page-no { font-size: 72pt; font-weight: 700; }
.blank { font-size: 20pt; color: #999; }
@media screen {
  body { background: #e5e7eb; padding: 16px 0; }
  .proof-page { margin: 0 auto 16px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); }
}
`;

/** 四角对位标（十字 + 圆），位置固定，不随爬移补偿移动 */
const REG_MARK =
  '<svg width="8mm" height="8mm" viewBox="0 0 8 8" aria-hidden="true">' +
  '<circle cx="4" cy="4" r="2.6" fill="none" stroke="#000" stroke-width="0.25"/>' +
  '<line x1="0" y1="4" x2="8" y2="4" stroke="#000" stroke-width="0.25"/>' +
  '<line x1="4" y1="0" x2="4" y2="8" stroke="#000" stroke-width="0.25"/>' +
  '</svg>';

function regMarksHtml() {
  return ['tl', 'tr', 'bl', 'br']
    .map((c) => `<div class="reg ${c}">${REG_MARK}</div>`)
    .join('');
}

/** 中央折线：虚线 + 上下边缘折线标记，位置固定 */
const FOLD_HTML =
  '<div class="fold" aria-hidden="true"></div>' +
  '<div class="fold-tick top" aria-hidden="true"></div>' +
  '<div class="fold-tick bottom" aria-hidden="true"></div>' +
  '<div class="fold-label">折线</div>';

/**
 * 单侧版位。爬移补偿仅平移页码内容（左版 +c 朝右、右版 −c 朝左，均朝折线），
 * 版位框（trim）与版位标签保持原位；creepMm 为 null 表示未启用补偿。
 */
function slotHtml(pos, value, creepMm) {
  const shift = creepMm === null
    ? ''
    : ` style="transform: translateX(${pos === 'left' ? '+' : '-'}${creepMm}mm)"`;
  const inner = value === null
    ? '<span class="blank">空白</span>'
    : `<span class="page-no">${value}</span>`;
  return (
    `<div class="slot ${pos}">` +
    '<div class="trim"></div>' +
    `<span class="slot-tag">${POS_LABEL[pos]}</span>` +
    `<div class="content"${shift}>${inner}</div>` +
    '</div>'
  );
}

/** 一张纸的某一面（一页 A4 横向打样） */
function proofPageHtml(state, sig, sheet, side) {
  const creepMm = state.creep ? sheet.creep.toFixed(2) : null;
  const sigPart = sig == null ? '' : `第 ${sig} 帖 · `;
  const creepPart = state.creep ? ` · 爬移 ${sheet.creep.toFixed(2)} mm` : '';
  const meta = `${sigPart}第 ${sheet.index} 张纸 · ${SIDE_LABEL[side]}${creepPart}`;
  return (
    '<section class="proof-page">' +
    regMarksHtml() +
    FOLD_HTML +
    `<header class="meta">${meta}</header>` +
    `<div class="print-note">${PRINT_NOTE}</div>` +
    slotHtml('left', sheet[side].left, creepMm) +
    slotHtml('right', sheet[side].right, creepMm) +
    '</section>'
  );
}

/**
 * 生成独立打样 HTML（不依赖任何外部资源）。
 * 每张纸输出正反两页，依帖号和帖内纸张顺序排列；结构非法返回 null。
 */
function buildProofHtml(raw) {
  const state = normalizeState(raw);
  if (!state) return null;
  const multi = state.mode === 'multi';
  const groups = multi ? state.signatures : [{ sig: null, sheets: state.sheets }];

  const pages = [];
  for (const g of groups) {
    for (const sheet of g.sheets) {
      pages.push(proofPageHtml(state, g.sig, sheet, 'front'));
      pages.push(proofPageHtml(state, g.sig, sheet, 'back'));
    }
  }

  const title = multi
    ? `打样 ${state.totalPages} 页 · ${state.signatureCount} 帖`
    : `打样 ${state.totalPages} 页`;
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
    `<title>${title}</title>\n` +
    `<style>${PROOF_CSS}</style>\n</head>\n<body>\n` +
    '<!-- 骑马钉拼版双面打样：A4 横向，浏览器按 100% 比例打印，双面选「短边翻转」；每张纸正反各一页，依帖号和帖内纸张顺序排列。 -->\n' +
    pages.join('\n') +
    '\n</body>\n</html>\n'
  );
}

module.exports = { buildProofHtml };
