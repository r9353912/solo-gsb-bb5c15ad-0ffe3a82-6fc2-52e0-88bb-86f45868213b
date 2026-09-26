'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateImposition } = require('../src/imposition');
const { buildProofHtml } = require('../src/proof');

/** 按打样页切分 HTML（每张纸正反各一页） */
function pagesOf(html) {
  return html
    .split('<section class="proof-page">')
    .slice(1)
    .map((p) => '<section class="proof-page">' + p);
}

test('打样：固定 A4 横向，每张纸正反各一页并按顺序排列', () => {
  const html = buildProofHtml(generateImposition(8)); // 2 张纸
  assert.ok(html.includes('size: A4 landscape'));
  assert.ok(html.startsWith('<!DOCTYPE html>'));

  const pages = pagesOf(html);
  assert.equal(pages.length, 4); // 2 张纸 × 正反 2 页
  assert.ok(pages[0].includes('第 1 张纸 · 正面'));
  assert.ok(pages[1].includes('第 1 张纸 · 反面'));
  assert.ok(pages[2].includes('第 2 张纸 · 正面'));
  assert.ok(pages[3].includes('第 2 张纸 · 反面'));
});

test('打样：每面标出左右页码、中央折线与四角对位标', () => {
  const html = buildProofHtml(generateImposition(8));
  const pages = pagesOf(html);
  for (const p of pages) {
    assert.equal((p.match(/class="reg (tl|tr|bl|br)"/g) || []).length, 4, '四角对位标');
    assert.ok(p.includes('fold-label">折线<'), '中央折线');
    assert.ok(p.includes('>左版<') && p.includes('>右版<'), '左右版位标签');
  }
  // 第 1 张正面 [8,1]：左版 8 在前、右版 1 在后
  assert.ok(pages[0].indexOf('page-no">8<') !== -1);
  assert.ok(pages[0].indexOf('page-no">8<') < pages[0].indexOf('page-no">1<'));
  // 第 1 张反面 [2,7]：左版 2、右版 7（与正面右版 1 同叶的第 2 页排在背面左版，
  // 即背面左右版位相对正面镜像排布，配合短边翻转打印）
  assert.ok(pages[1].indexOf('page-no">2<') !== -1);
  assert.ok(pages[1].indexOf('page-no">2<') < pages[1].indexOf('page-no">7<'));
});

test('打样：空白版位以「空白」标出', () => {
  const html = buildProofHtml(generateImposition(6)); // 补齐至 8 页，2 个空白版位
  assert.equal((html.match(/<span class="blank">空白<\/span>/g) || []).length, 2);
});

test('打样：未启用爬移补偿时不产生任何平移', () => {
  const html = buildProofHtml(generateImposition(8));
  assert.ok(!/style="transform: translateX\(/.test(html), '版位内容不应带爬移平移');
});

test('打样：爬移补偿仅平移页码内容，对位标与折线保持原位', () => {
  const html = buildProofHtml(generateImposition(8, null, { thickness: 0.1, cap: 2 }));
  const pages = pagesOf(html);

  // 第 1 张 c=0：左右版内容分别 translateX(+0.00mm) / translateX(-0.00mm)
  assert.ok(pages[0].includes('translateX(+0.00mm)'));
  assert.ok(pages[0].includes('translateX(-0.00mm)'));
  // 第 2 张 c=0.20：正反面同样补偿（左版 +0.20 向右、右版 −0.20 向左，朝折线）
  for (const p of [pages[2], pages[3]]) {
    assert.ok(p.includes('translateX(+0.20mm)'));
    assert.ok(p.includes('translateX(-0.20mm)'));
  }
  // 每页恰好 2 处平移（仅左右版页码内容）
  for (const p of pages) {
    assert.equal((p.match(/translateX\(/g) || []).length, 2);
  }
  // 对位标、折线、版位框与标签均不带 style（保持原位）
  assert.ok(!/<div class="reg[^"]*"[^>]*style=/.test(html));
  assert.ok(!/<div class="fold[^"]*"[^>]*style=/.test(html));
  assert.ok(!/<div class="trim"[^>]*style=/.test(html));
  assert.ok(!/<span class="slot-tag"[^>]*style=/.test(html));
});

test('打样：分帖模式依帖号和帖内纸张顺序排列', () => {
  const html = buildProofHtml(generateImposition(10, 2)); // 第 1 帖 2 张、第 2 帖 1 张
  const pages = pagesOf(html);
  assert.equal(pages.length, 6); // 3 张纸 × 正反 2 页
  assert.ok(pages[0].includes('第 1 帖 · 第 1 张纸 · 正面'));
  assert.ok(pages[1].includes('第 1 帖 · 第 1 张纸 · 反面'));
  assert.ok(pages[2].includes('第 1 帖 · 第 2 张纸 · 正面'));
  assert.ok(pages[3].includes('第 1 帖 · 第 2 张纸 · 反面'));
  assert.ok(pages[4].includes('第 2 帖 · 第 1 张纸 · 正面'));
  assert.ok(pages[5].includes('第 2 帖 · 第 1 张纸 · 反面'));
  // 第 2 帖（末帖）补空白
  assert.ok(pages[4].includes('<span class="blank">空白</span>'));
  assert.ok(pages[5].includes('<span class="blank">空白</span>'));
});

test('打样：分帖爬移补偿每帖独立从第 1 张起算', () => {
  const html = buildProofHtml(generateImposition(16, 2, { thickness: 0.1, cap: 5 }));
  const pages = pagesOf(html);
  // 两帖各 2 张：每帖第 1 张 c=0、第 2 张 c=0.20
  assert.ok(pages[0].includes('translateX(+0.00mm)')); // 第 1 帖第 1 张正面
  assert.ok(pages[2].includes('translateX(+0.20mm)')); // 第 1 帖第 2 张正面
  assert.ok(pages[4].includes('translateX(+0.00mm)')); // 第 2 帖第 1 张正面（重新起算）
  assert.ok(pages[6].includes('translateX(+0.20mm)')); // 第 2 帖第 2 张正面
});

test('打样：结构非法或爬移数据被篡改时返回 null', () => {
  assert.equal(buildProofHtml(null), null);
  assert.equal(buildProofHtml({ pages: 8, totalPages: 8, sheets: [{}] }), null);

  const tampered = generateImposition(8, null, { thickness: 0.1, cap: 2 });
  tampered.sheets[1].creep = 0.9;
  assert.equal(buildProofHtml(tampered), null);
});
