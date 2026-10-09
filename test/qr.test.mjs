/**
 * 二维码编码器测试。
 *
 * 手写 Reed-Solomon 这种事，靠「扫出来看着像」是不作数的。这里用两条独立的证据：
 *
 *   1. 与 qrcode（npm 参考实现）**逐模块比对**。两边都按规范选掩码，所以矩阵必须
 *      一模一样 —— 有一个 bit 不同就说明 RS、掩码评分或格式信息里错了一处。
 *   2. 用 jsqr 把渲染出的像素**解回来**，确认真实扫码器读得出。
 *
 * 需要 node_modules（npm i），只有测试用得到，页面本身依旧是零依赖。
 *
 *   node --test test/qr.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const ref = require('qrcode');
const jsQRmod = require('jsqr');
const jsQR = jsQRmod.default || jsQRmod;

function loadQR(){
  const m = html.match(/\/\/ ==== QR:BEGIN ====([\s\S]*?)\/\/ ==== QR:END ====/);
  if (!m) throw new Error('index.html 里找不到 QR:BEGIN / QR:END 标记');
  return new Function(m[1] + '\n;return QRCode;')();
}
const QR = loadQR();

/* ─────────────────────── 与参考实现比对 ─────────────────────── */

/**
 * 参考实现的模块矩阵，转成和自家一样的二维数组。
 *
 * 这里**钉死 byte 模式**：qrcode 会自动把纯字母数字内容切成 alphanumeric 段
 * （5.5 bit/字符，比 byte 模式的 8 bit 省），而围响只用 byte 模式。不钉死的话
 * 比的是两种分段策略，不是编码正确性。真实信令是 base64url，含小写字母和 - _
 * 都不在 alphanumeric 字符集里，所以本来就走 byte 模式。
 */
function refMatrix(text, level, mask){
  const opts = { errorCorrectionLevel: level };
  if (mask !== undefined) opts.maskPattern = mask;
  const q = ref.create([{ data: text, mode: 'byte' }], opts);
  const n = q.modules.size;
  const out = [];
  for (let r = 0; r < n; r++){
    const row = [];
    for (let c = 0; c < n; c++) row.push(q.modules.data[r * n + c] ? 1 : 0);
    out.push(row);
  }
  return { version: q.version, mask: q.maskPattern, matrix: out, size: n };
}

/** 找出两个矩阵第一处不同，报出坐标方便排查 */
function firstDiff(a, b){
  for (let r = 0; r < a.length; r++){
    for (let c = 0; c < a[r].length; c++){
      if (a[r][c] !== b[r][c]) return { r, c, mine: a[r][c], theirs: b[r][c] };
    }
  }
  return null;
}

function assertSameMatrix(text, level, mask){
  const mine = mask === undefined
    ? QR.encode(text, { level })
    : QR.encode(text, { level, mask });
  const theirs = refMatrix(text, level, mask);

  assert.equal(mine.version, theirs.version,
    `版本选得不一样：自家 v${mine.version}，参考 v${theirs.version}`);
  assert.equal(mine.size, theirs.size, '尺寸对不上');
  assert.equal(mine.mask, theirs.mask,
    `掩码选得不一样：自家 ${mine.mask}，参考 ${theirs.mask}（说明罚分算法有出入）`);

  const d = firstDiff(mine.modules, theirs.matrix);
  assert.equal(d, null,
    d ? `矩阵在 (${d.r},${d.c}) 不同：自家 ${d.mine}，参考 ${d.theirs}` : '');
}

// 覆盖各档版本：v1 起步、v6 起有多 RS 块、v7 起带版本信息、
// v10 起字符数域变 16 位、以及逼近 M 档上限的版本
const SAMPLES = [
  ['短', 'hi'],
  ['信令包长度', 'https://example.com/gp/#o=z' + 'A'.repeat(60)],
  ['中长', 'x'.repeat(220)],
  ['跨 v10 边界', 'y'.repeat(300)],
  ['需要版本信息', 'z'.repeat(700)],
  ['多 RS 块', 'q'.repeat(1400)],
  ['逼近 M 档上限', 'w'.repeat(2200)],
  ['中文（多字节）', '围响：房间 ' + '一二三四五六七八九十'.repeat(12)],
];

for (const [label, text] of SAMPLES){
  test(`与参考实现逐模块一致 —— ${label}（${text.length} 字符）`, () => {
    assertSameMatrix(text, 'M');
  });
}

test('L 档也能逐模块对上', () => {
  for (const [, text] of SAMPLES) assertSameMatrix(text, 'L');
});

test('八个掩码逐个强制比对 —— 把编码和选掩码拆开验', () => {
  // 上一条测的是「结果一样」，这条测的是「每条路径都一样」：
  // 排除掉「掩码恰好选对掩盖了编码错误」这种可能。
  for (const [, text] of SAMPLES){
    for (let mask = 0; mask < 8; mask++){
      assertSameMatrix(text, 'M', mask);
    }
  }
});

test('每个版本的 M 档容量边界都与参考实现一致', () => {
  for (let v = 1; v <= 40; v++){
    const cap = QR.dataCapacityBytes(v, 'M');

    // 刚好填满：必须还是这个版本
    const at = ref.create('a'.repeat(cap), { errorCorrectionLevel: 'M' });
    assert.equal(at.version, v,
      `v${v} 容量边界算错：自家说 ${cap}，参考把它排到了 v${at.version}`);

    // 多一个字符：必须落到更高的版本
    if (v < 40){
      const over = ref.create('a'.repeat(cap + 1), { errorCorrectionLevel: 'M' });
      assert.ok(over.version > v, `v${v} 的容量算大了`);
    }
  }
});

/* ─────────────────── 格式信息排布（回归） ─────────────────── */

test('★ 格式信息两个副本的走向与参考实现一致', () => {
  // 这里踩过坑：低位/高位放反了，而且预保留时把 (6,8) (8,6) 两个定时模块清成了 0。
  const qr = QR.encode('hi', { level: 'M', mask: 0 });
  const R = refMatrix('hi', 'M', 0).matrix;

  // 第一副本走第 8 列：低位在上
  for (let r = 0; r <= 5; r++) assert.equal(qr.modules[r][8], R[r][8], `(0${r},8) 对不上`);
  assert.equal(qr.modules[7][8], R[7][8]);
  assert.equal(qr.modules[8][8], R[8][8]);
  // 第二副本走第 8 行：低位在右
  for (let c = 0; c <= 5; c++) assert.equal(qr.modules[8][c], R[8][c], `(8,${c}) 对不上`);
  assert.equal(qr.modules[8][7], R[8][7]);

  // 两个定时模块不能被格式信息区踩掉
  assert.equal(qr.modules[6][8], 1, '(6,8) 是定时图案，必须是 1');
  assert.equal(qr.modules[8][6], 1, '(8,6) 是定时图案，必须是 1');

  // 固定黑点
  assert.equal(qr.modules[qr.size - 8][8], 1, '固定黑点丢了');
});

test('十五位格式串是合法的 BCH(15,5) 码字', () => {
  const { formatBits } = QR._internal;
  const G15 = 0x537;                                  // 生成多项式，次数 10

  const deg = (v) => { let d = -1; while (v){ v >>= 1; d++; } return d; };
  /** GF(2) 多项式取余：余数为 0 才说明是合法码字 */
  const mod = (v) => {
    while (deg(v) >= deg(G15)) v ^= G15 << (deg(v) - deg(G15));
    return v;
  };

  // M / mask0 是规范里给的那个著名常量 0x5412
  assert.equal(formatBits('M', 0), 0x5412);

  const ecBit = { L: 1, M: 0 };
  for (const level of ['L', 'M']){
    for (let mask = 0; mask < 8; mask++){
      const fmt = formatBits(level, mask);
      assert.ok(fmt >= 0 && fmt < (1 << 15), '超出 15 位');
      assert.equal(mod(fmt ^ 0x5412), 0,
        `${level}/${mask} 不是合法码字，说明 BCH 算错了`);
      // 高 5 位必须是「纠错档 + 掩码」原样
      assert.equal((fmt ^ 0x5412) >> 10, (ecBit[level] << 3) | mask,
        `${level}/${mask} 的数据位不对`);
    }
  }
});

/* ─────────────────── RS 编码的独立证据 ─────────────────── */

test('RS 生成多项式是首一多项式，且次数正确', () => {
  const { rsGenPoly } = QR._internal;
  for (const n of [7, 10, 16, 26, 30]){
    const g = rsGenPoly(n);
    assert.equal(g.length, n + 1, `${n} 次生成多项式长度不对`);
    assert.equal(g[0], 1, '首项必须是 1（首一）');
  }
});

/* ─────────────────── 真解码器读得出来 ─────────────────── */

function decode(qr, scale = 4){
  const { data, width, height } = QR.toRGBA(qr, { scale, margin: 4 });
  return jsQR(data, width, height);
}

test('对照组：jsqr 本来就能解参考实现的码', () => {
  // 先确认 jsqr 在这个环境里是有效的，否则下面的解码测试等于没测
  const R = refMatrix('hello 围响', 'M');
  const n = R.size, S = 4, MG = 4, dim = (n + MG * 2) * S;
  const buf = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < n; r++){
    for (let c = 0; c < n; c++){
      if (!R.matrix[r][c]) continue;
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++){
        const o = (((r + MG) * S + dy) * dim + (c + MG) * S + dx) * 4;
        buf[o] = buf[o + 1] = buf[o + 2] = 0;
      }
    }
  }
  const got = jsQR(buf, dim, dim);
  assert.ok(got, 'jsqr 连参考实现的码都解不出来，说明测试环境有问题');
  assert.equal(got.data, 'hello 围响');
});

test('jsqr 能解出短文本', () => {
  const got = decode(QR.encode('hello 围响'));
  assert.ok(got, 'jsqr 没解出来');
  assert.equal(got.data, 'hello 围响');
});

test('jsqr 能解出真实长度的信令包', () => {
  // 形状贴近实际：压缩后的 SDP 信令，base64url，约 300 字符
  const payload = 'v=0 o=- 4611731400430051336 2 IN IP4 127.0.0.1 s=- t=0 0 a=group:BUNDLE 0 ' +
    'a=ice-ufrag:4ZcD a=ice-pwd:2/1muCWoOi3uLifh0NuRHlTO a=fingerprint:sha-256 ' +
    Array.from({ length: 24 }, (_, i) => (i % 16).toString(16).toUpperCase().padStart(2, '0')).join(':') +
    ' a=setup:actpass a=mid:0 a=sctp-port:5000';
  const packed = 'z' + Buffer.from(payload).toString('base64url');
  assert.ok(packed.length > 250, `样本太短了：${packed.length}`);

  const got = decode(QR.encode(packed));
  assert.ok(got, 'jsqr 没解出信令包');
  assert.equal(got.data, packed, '解回来的内容和编码进去的不一样');
});

test('中文与 emoji 也能原样解回来', () => {
  for (const s of ['围响 GatherPop', '🎲🎯🕵️', '一二三四五六七八九十'.repeat(8)]){
    const got = decode(QR.encode(s));
    assert.ok(got, `jsqr 没解出来：${s}`);
    assert.equal(got.data, s);
  }
});

test('v1 到 v25 每一档都真的能被 jsqr 读出来', () => {
  for (let v = 1; v <= 25; v++){
    const cap = QR.dataCapacityBytes(v, 'M');
    // 构造一个刚好占满这一档容量的内容
    const prefix = `v${v}:`;
    const text = prefix + 'k'.repeat(cap - prefix.length);
    const qr = QR.encode(text, { level: 'M' });
    assert.equal(qr.version, v, `本该落在 v${v}，实际 v${qr.version}`);

    const got = decode(qr, 3);
    assert.ok(got, `v${v} 的码 jsqr 读不出来`);
    assert.equal(got.data, text, `v${v} 解回来的内容不对`);
  }
});

/* ─────────────────── SVG 输出 ─────────────────── */

test('SVG 是自包含的，且深度与模块数一致', () => {
  const qr = QR.encode('围响', { level: 'M' });
  const svg = QR.toSvg(qr, { scale: 4, margin: 4 });
  const n = qr.size;

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.doesNotMatch(svg, /<script/i, 'SVG 里不该有脚本');

  // 每个黑模块一段子路径，段数必须恰好等于黑模块数
  const segs = (svg.match(/M\d+ \d+h\d+v\d+h-\d+z/g) || []).length;
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules[r][c]) dark++;
  assert.equal(segs, dark, 'SVG 路径段数与黑模块数对不上');

  // 尺寸 = (模块数 + 两边留白) × 缩放
  assert.match(svg, new RegExp(`width="${(n + 8) * 4}"`));
});

/* ─────────────────── 边界 ─────────────────── */

test('内容塞不下时抛出人话错误，而不是给出坏码', () => {
  assert.throws(() => QR.encode('a'.repeat(5000), { level: 'M' }), /太长/);
});

test('M 档装不下会自动退到 L 档，且退完还读得出来', () => {
  const len = QR.dataCapacityBytes(40, 'M') + 10;   // M 装不下，L 装得下
  assert.ok(len <= QR.dataCapacityBytes(40, 'L'), '样本长度选得不对');

  const qr = QR.encode('a'.repeat(len), { level: 'M' });
  assert.equal(qr.level, 'L', '应当退到 L 档');
  assert.equal(qr.level === 'L' && qr.version <= 40, true);

  const got = decode(qr, 2);
  assert.ok(got, '退档之后 jsqr 读不出来');
  assert.equal(got.data.length, len);
});
