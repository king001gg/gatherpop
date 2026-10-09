/**
 * 界面层冒烟测试。
 *
 * 没有浏览器，所以用一个极简假 DOM 把 index.html 的四段 script（核心域、二维码、
 * 传输、界面）拼在一起跑，再模拟点击走一遍真实交互路径。目的不是测样式，是确保
 * UI 层不抛异常、边界上给得出人话提示、以及扫码配对那套页面切得对。
 *
 * RTCPeerConnection 用 test/fake-rtc.mjs 顶上，BroadcastChannel 用一个同理的
 * 内存总线 —— 于是「房主邀请 → 加入端回执 → 转送回原页面」这条完整链路可以在
 * Node 里跑一遍。
 *
 *   node --test test/ui.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FakePeerConnection, resetRtc } from './fake-rtc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const srcOf = (id) => html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`))[1];
const coreSrc = html.match(/\/\/ ==== CORE:BEGIN ====([\s\S]*?)\/\/ ==== CORE:END ====/)[1];
const qrSrc   = html.match(/\/\/ ==== QR:BEGIN ====([\s\S]*?)\/\/ ==== QR:END ====/)[1];
const netSrc  = html.match(/\/\/ ==== NET:BEGIN ====([\s\S]*?)\/\/ ==== NET:END ====/)[1];
const uiSrc   = srcOf('gatherpop-ui');

beforeEach(resetRtc);

/* 页面里挂着的定时器（比如等待回执的那 20 秒）在用例结束后要收掉，
   否则 node --test 会一直等到它们全部到期，白等一大截。 */
const pending = [];
afterEach(() => { for (const id of pending.splice(0)) clearTimeout(id); });

/* ─────────────── 内存版 BroadcastChannel ─────────────── */

/** 同源页面之间互投。真实实现不会投给自己，这里也一样。 */
function makeBus(){
  const open = [];
  return class FakeBroadcastChannel {
    constructor(name){ this.name = name; this.onmessage = null; open.push(this); }
    postMessage(data){
      for (const ch of open.slice()){
        if (ch !== this && ch.name === this.name && ch.onmessage) ch.onmessage({ data });
      }
    }
    close(){ const i = open.indexOf(this); if (i >= 0) open.splice(i, 1); }
  };
}

/* ─────────────── 极简假 DOM ─────────────── */

function fakeDom(){
  const byId = {};
  const listeners = {};
  const body = {
    children: [],
    appendChild(el){ this.children.push(el); if (el.id) byId[el.id] = el; },
  };
  const document = {
    body,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => ({ tag, id:'', className:'', textContent:'' }),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  };

  /* 真实浏览器里 innerHTML 一赋下去，那段字就变成了活节点。
     这里只做测试真正要用的那一点：把带 id 的 <input> 登记出来，
     好让 getElementById 拿得到它的 value 和 data-ui。
     querySelector 一律返回 null —— afterRender 拿 canvas 用的，
     测试里没有真画布，正好也顺带验了「拿不到节点也不许炸」。 */
  let _html = '';
  const canvases = [];        // 每次渲染 iframe 出来的画布节点，按渲染顺序攒着
  byId.app = {
    canvases,
    get innerHTML(){ return _html; },
    set innerHTML(v){
      _html = String(v);
      for (const m of _html.matchAll(/<input\b[^>]*>/g)){
        const tag = m[0];
        const id = (tag.match(/\bid="([^"]*)"/) || [])[1];
        if (!id) continue;
        const dataUi = (tag.match(/\bdata-ui="([^"]*)"/) || [])[1] || null;
        const value = (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '';
        byId[id] = {
          id, value, handlers:{},
          getAttribute: (k) => (k === 'data-ui' ? dataUi : null),
          addEventListener(t, fn){ (this.handlers[t] = this.handlers[t] || []).push(fn); },
        };
      }
    },
    /* 认 #id 和 canvas 两种选择器。canvas 只在 HTML 里真的有 <canvas> 时才给
       节点 —— 别的插件问要节点一律 null，顺带验了「拿不到节点也不许炸」。
       getContext 返回个空壳 2D 上下文，dgPaint 撞上它会自己早退，
       指针事件那条路才测得到。 */
    querySelector(sel){
      const s = String(sel);
      const m = /^#(.+)$/.exec(s);
      if (m) return byId[m[1]] || null;
      if (!/canvas/i.test(s) || !_html.includes('<canvas')) return null;
      const cv = {
        clientWidth: 300, clientHeight: 300, width: 0, height: 0,
        handlers: {},
        getContext: () => ({}),
        addEventListener(t, fn){ (this.handlers[t] = this.handlers[t] || []).push(fn); },
        getBoundingClientRect: () => ({ left:0, top:0, width:300, height:300 }),
      };
      canvases.push(cv);
      return cv;
    },
  };
  return { document, listeners, byId, canvases };
}

/**
 * 起一个「页面」。同一个 BroadcastChannel 总线可以让多个页面互相转送信令，
 * 模拟真实的多标签页场景。
 */
const track = (fn, ms, ...rest) => { const id = setTimeout(fn, ms, ...rest); pending.push(id); return id; };
const untrack = (id) => { const i = pending.indexOf(id); if (i >= 0) pending.splice(i, 1); clearTimeout(id); };

/* 界面层是包在 IIFE 里的，ctrl 出不来。测试里要能把房间凑够三个人
   （界面本身不提供加人的操作），所以把那层括号换成一次「交出来」的回调 ——
   跑的还是同一段界面代码，一个字没改，只是多了条缝。 */
function uiSrcWithSeam(src){
  // 在收尾那对括号之前插一句「把 ctrl 交出去」—— 插在开头会撞上 ctrl 的 TDZ
  const out = src.replace(/\}\)\(\);\s*$/, '\n__expose.ctrl = ctrl;\n})();\n');
  if (out === src) throw new Error('界面层的 IIFE 收尾变了，这个测试缝要跟着改');
  return out;
}

function boot({ hash = '', BroadcastChannel: Bus } = {}){
  const dom = fakeDom();
  const location = { origin:'https://x.test', pathname:'/', search:'', hash };
  const history = { replaceState: () => { location.hash = ''; } };
  // prompt 的返回值可以逐次设定 —— 「粘链接进来」那条路要靠它
  let prompted = null;
  const exposed = {};
  const factory = new Function(
    'document', 'prompt', 'setTimeout', 'clearTimeout', 'RTCPeerConnection', 'BroadcastChannel',
    'location', 'history', '__expose',
    coreSrc + '\n' + qrSrc + '\n' + netSrc + '\n' + uiSrcWithSeam(uiSrc) + '\n;return GP;'
  );
  const GP = factory(dom.document, () => prompted, track, untrack,
                     FakePeerConnection, Bus, location, history, exposed);
  const ctrl = () => exposed.ctrl;

  const click = (act) => {
    const el = { closest: () => ({ getAttribute: () => JSON.stringify(act) }) };
    for (const fn of dom.listeners.click || []) fn({ target: el });
  };
  const type = (id, value) => {
    // 输入框得是真的刚渲染出来的那个节点 —— 外壳要从它身上读 data-ui
    const el = dom.byId[id];
    if (!el) throw new Error(`屏幕上没有 id=${id} 的输入框`);
    el.value = value;
    for (const fn of dom.listeners.input || []) fn({ target: el });
  };
  /* 在某个输入框上敲一个键 —— 插件用 afterRender 挂上去的监听走这条路 */
  const press = (id, key = 'Enter') => {
    const el = dom.byId[id];
    if (!el || !el.handlers || !el.handlers.keydown){
      throw new Error(`id=${id} 上没有 keydown 监听`);
    }
    for (const fn of el.handlers.keydown) fn({ key });
  };
  return { GP, ctrl, dom, click, type, press, setPrompt: (v) => { prompted = v; },
           html: () => dom.byId.app.innerHTML };
}

/** 轮询等待渲染结果 —— 配对流程里有真实的 await */
async function until(fn, ms = 800){
  const t0 = Date.now();
  for (;;){
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

const grabUrl = (h, kind) =>
  (h.match(new RegExp(`https://[^<\\s]*#${kind}=[A-Za-z0-9\\-_]+`)) || [])[0];
const hashOf = (url) => '#' + url.split('#')[1];

/* ───────────────────────── 首页 ───────────────────────── */

test('首页按聚会节奏分组，而不是按游戏类型罗列', () => {
  const { html } = boot();
  assert.match(html(), /等人 · 暖场/);
  assert.match(html(), /饭前 · 饭后/);
  assert.match(html(), /记分 · 随机/);
});

test('首页把「围响不做什么」写出来了', () => {
  const { html } = boot();
  const h = html();
  for (const claim of ['不需要账号', '不收集任何数据', '不经过任何服务器']){
    assert.ok(h.includes(claim), `首页缺少这条声明：${claim}`);
  }
});

test('首页列出全部已注册的游戏', () => {
  const { GP, html } = boot();
  for (const p of GP.GAME_PLUGINS){
    assert.ok(html().includes(p.name), `首页没有列出 ${p.name}`);
  }
});

test('支持 WebRTC 时首页说的是「扫码联机」', () => {
  const { html } = boot({ BroadcastChannel: makeBus() });
  assert.match(html(), /邀请玩家/);
  assert.doesNotMatch(html(), /不支持点对点联机/);
});

/** 起一个「浏览器根本不支持 WebRTC」的页面 */
function bootNoRtc(hash = ''){
  const dom = fakeDom();
  const factory = new Function(
    'document', 'prompt', 'setTimeout', 'clearTimeout', 'RTCPeerConnection', 'BroadcastChannel', 'location', 'history',
    coreSrc + '\n' + qrSrc + '\n' + netSrc + '\n' + uiSrc + '\n;return GP;'
  );
  factory(dom.document, () => null, track, untrack, undefined, undefined,
          { origin:'https://x.test', pathname:'/', search:'', hash }, { replaceState(){} });
  return dom.byId.app.innerHTML;
}

test('没有 WebRTC 时首页老实说是单机模式', () => {
  assert.match(bootNoRtc(), /单机模式/);
});

/* ───────────────────────── 建房 ───────────────────────── */

test('点「建个房间」进入房间页，成员栏和记分牌都在', () => {
  const { click, html } = boot();
  click({ t:'create', name:'小明' });
  const h = html();
  assert.match(h, /记分牌/);
  assert.match(h, /小明/);
  assert.match(h, /房主/);
  assert.match(h, /换游戏不会清空/);
});

/* ───────────────── 人数不够时的边界 ───────────────── */

test('人不够时点「谁是卧底」给提示，而不是抛异常', () => {
  const { click, dom, html } = boot();
  click({ t:'create', name:'小明' });

  assert.doesNotThrow(() => click({ t:'switch', game:'undercover' }),
    '人数不够时不该把异常抛到控制台');
  assert.match(dom.byId.toast.textContent, /至少要 3 人/);
  assert.equal(dom.byId.toast.className, 'show');
  assert.match(html(), /上面挑一个游戏开始|记分牌/);
});

test('人不够时首页点游戏也走同一条提示路径', () => {
  const { click, dom } = boot();
  assert.doesNotThrow(() => click({ t:'start', game:'undercover' }));
  assert.match(dom.byId.toast.textContent, /至少要 3 人/);
});

/* ───────────────── 完整走一遍：开局 → 操作 ───────────────── */

test('开一局骰子并掷出结果，界面不报错且结果落到页面上', () => {
  const { click, html } = boot();
  click({ t:'create', name:'小明' });
  click({ t:'start', game:'dice' });
  assert.match(html(), /掷 D6/);

  click({ t:'roll', sides:6 });
  assert.match(html(), /掷出了/, '掷完之后应当显示结果');
  assert.doesNotMatch(html(), /历史：/, '只掷一次时不该有历史');

  click({ t:'roll', sides:6 });
  assert.match(html(), /历史：/, '掷过两次之后应当出现历史');
});

test('记分牌加减分后数值出现在页面上', () => {
  const { click, html } = boot();
  click({ t:'create', name:'小明' });

  const hostId = html().match(/data-act='\{"t":"scoreAdd","member":"([^"]+)"/)[1];
  click({ t:'scoreAdd', member: hostId, delta: 1 });
  click({ t:'scoreAdd', member: hostId, delta: 1 });
  assert.match(html(), /<span class="val">2<\/span>/, '两次加分之后应当显示 2');

  click({ t:'resetScores' });
  assert.match(html(), /<span class="val">0<\/span>/, '清零后应当回到 0');
});

test('切到转盘再切回来，成员栏和记分牌都还在', () => {
  const { click, html } = boot();
  click({ t:'create', name:'小明' });

  click({ t:'start', game:'dice' });
  click({ t:'switch', game:'wheel' });
  assert.match(html(), /转一下|转到了/, '应当渲染出转盘');

  click({ t:'switch', game:'dice' });
  const h = html();
  assert.match(h, /记分牌/);
  assert.match(h, /小明/);
  assert.match(h, /今晚玩过/, '切过游戏之后应当出现历史');
});

test('回到首页是干净的，不留房间残留', () => {
  const { click, html } = boot();
  click({ t:'create', name:'小明' });
  click({ t:'goHome' });
  const h = html();
  assert.match(h, /建个房间/);
  assert.doesNotMatch(h, /resetScores/, '首页不该残留房间里的记分牌面板');
  assert.doesNotMatch(h, /data-act='\{"t":"switch"/, '首页不该残留游戏切换栏');
});

/* ───────────────────── 邀请浮层 ───────────────────── */

test('房主点「邀请玩家」会出一张二维码', async () => {
  const { click, html } = boot({ BroadcastChannel: makeBus() });
  click({ t:'create', name:'小明' });
  assert.match(html(), /邀请玩家/, '房主的房间页应当有这个按钮');

  click({ t:'invite' });
  await until(() => /<svg/.test(html()));

  const h = html();
  assert.match(h, /<svg xmlns/, '应当渲染出二维码');
  assert.ok(grabUrl(h, 'o'), '二维码里装的应当是一个带 #o= 的邀请链接');
  assert.match(h, /系统相机/, '要告诉用户用相机扫');
});

test('加入端扫了邀请码，落到的页面上有一张回执二维码', async () => {
  const bus = makeBus();
  const host = boot({ BroadcastChannel: bus });
  host.click({ t:'create', name:'小明' });
  host.click({ t:'invite' });
  await until(() => grabUrl(host.html(), 'o'));
  const offerUrl = grabUrl(host.html(), 'o');

  // 模拟「用相机扫了邀请码，打开一个新页面」
  const guest = boot({ BroadcastChannel: bus, hash: hashOf(offerUrl) });
  await until(() => grabUrl(guest.html(), 'a'));

  const h = guest.html();
  assert.match(h, /<svg xmlns/, '加入端应当显示回执二维码');
  assert.match(h, /房主用相机扫/, '要写清楚谁来扫');
  assert.ok(grabUrl(h, 'a'), '回执里装的应当是带 #a= 的链接');
});

test('★ 完整往返：邀请码 → 回执码 → 房主扫回执 → 接上', async () => {
  const bus = makeBus();

  // 1. 房主建房并亮出邀请码
  const host = boot({ BroadcastChannel: bus });
  host.click({ t:'create', name:'房主' });
  host.click({ t:'invite' });
  await until(() => grabUrl(host.html(), 'o'));
  const offerUrl = grabUrl(host.html(), 'o');

  // 2. 加入端扫码进入，生成回执码
  const guest = boot({ BroadcastChannel: bus, hash: hashOf(offerUrl) });
  await until(() => grabUrl(guest.html(), 'a'));
  const answerUrl = grabUrl(guest.html(), 'a');

  // 3. 房主扫回执 —— 落在一个新标签页，由它把回执转回原页面
  const relay = boot({ BroadcastChannel: bus, hash: hashOf(answerUrl) });
  assert.match(relay.html(), /正在把回执转回/, '一进来先说自己在干什么');
  await until(() => /回执已转回/.test(relay.html()), 1500);
  assert.match(relay.html(), /这一页可以直接关掉/, '转送成功才敢让用户关页面');

  // 4. 原页面收到回执、接上，加入端自动进房间
  await until(() => /2 人/.test(host.html()), 1500);
  assert.match(host.html(), /房主/, '房主还在');
  await until(() => /记分牌/.test(guest.html()), 1500);
  assert.match(guest.html(), /已连上房主/, '加入端应当意识到自己连上了');
});

test('★ 原来那页已经关了：转送页老实说没送到，而不是谎报成功', async () => {
  // 总线上只有转送页自己 —— 没人接，也就没有回执
  const relay = boot({ BroadcastChannel: makeBus(), hash: '#a=zSOMETHING' });
  assert.match(relay.html(), /正在把回执转回/);
  await until(() => /没找到原来的房间页/.test(relay.html()), 3000);
  assert.doesNotMatch(relay.html(), /回执已转回/, '没送到就不能说送到了');
  assert.match(relay.html(), /同一台设备/, '要给出可操作的下一步');
});

test('房间页在没有邀请时不该有浮层', () => {
  const { click, html } = boot({ BroadcastChannel: makeBus() });
  click({ t:'create', name:'小明' });
  assert.doesNotMatch(html(), /class="overlay"/);
});

test('关掉邀请浮层之后二维码就没了', async () => {
  const { click, html } = boot({ BroadcastChannel: makeBus() });
  click({ t:'create', name:'小明' });
  click({ t:'invite' });
  await until(() => /<svg/.test(html()));

  click({ t:'closeInvite' });
  assert.doesNotMatch(html(), /class="overlay"/);
  assert.match(html(), /记分牌/, '应当还留在房间页');
});

/* ─────────── 完全绕开相机：全程粘贴 ─────────── */

test('★ 不扫任何码，全靠粘贴也能走完配对', async () => {
  const bus = makeBus();

  // 1. 房主建房、出邀请码
  const host = boot({ BroadcastChannel: bus });
  host.click({ t:'create', name:'房主' });
  host.click({ t:'invite' });
  await until(() => grabUrl(host.html(), 'o'));
  const offerUrl = grabUrl(host.html(), 'o');

  // 2. 朋友那边不扫码，直接粘邀请链接进来
  const guest = boot({ BroadcastChannel: bus });
  guest.setPrompt(offerUrl);          // 模拟 prompt 里粘了整条链接
  guest.click({ t:'pasteOffer' });
  await until(() => grabUrl(guest.html(), 'a'));
  const answerUrl = grabUrl(guest.html(), 'a');

  // 3. 房主也不扫码，把回执链接粘回去
  host.setPrompt(answerUrl);
  host.click({ t:'acceptAnswer' });

  // 4. 接上
  await until(() => /2 人/.test(host.html()), 1500);
  await until(() => /已连上房主/.test(guest.html()), 1500);
});

test('粘贴进来的只是载荷、不带链接前缀，也认', async () => {
  const bus = makeBus();
  const host = boot({ BroadcastChannel: bus });
  host.click({ t:'create', name:'房主' });
  host.click({ t:'invite' });
  await until(() => grabUrl(host.html(), 'o'));
  const payload = grabUrl(host.html(), 'o').split('#o=')[1];

  const guest = boot({ BroadcastChannel: bus });
  guest.setPrompt(payload);           // 只粘了 #o= 后面那一段
  guest.click({ t:'pasteOffer' });
  await until(() => grabUrl(guest.html(), 'a'), 1500);
});

/* ───────────────────── 自检 ───────────────────── */

test('首页有「粘进来」和「自检」两个入口', () => {
  const { html } = boot({ BroadcastChannel: makeBus() });
  assert.match(html(), /有邀请码，粘进来/);
  assert.match(html(), /联机自检/);
});

test('自检会把这项设备的实际情况列出来，而不是只说「支持」', async () => {
  const { click, html } = boot({ BroadcastChannel: makeBus() });
  click({ t:'selfCheck' });
  await until(() => /邀请码长度/.test(html()), 3000);

  const h = html();
  // 四类能力必须逐条报
  for (const cap of ['WebRTC 数据通道', 'BroadcastChannel', 'CompressionStream', 'DecompressionStream']){
    assert.ok(h.includes(cap), `自检漏了 ${cap}`);
  }
  // 真的建了连接、真的量了码
  assert.match(h, /收集到的候选/, '要报实际收到的候选数');
  assert.match(h, /邀请码长度/, '要量出真实的码长');
  assert.match(h, /二维码/, '要报出二维码版本');
  assert.match(h, /v\d+，\d+×\d+/, '二维码那行要带上版本和尺寸');
});

test('自检是一个可以关掉的浮层，关掉不留下东西', async () => {
  const { click, html } = boot({ BroadcastChannel: makeBus() });
  click({ t:'selfCheck' });
  await until(() => /邀请码长度/.test(html()), 3000);
  assert.match(html(), /class="overlay"/);

  click({ t:'closeSelfCheck' });
  assert.doesNotMatch(html(), /class="overlay"/);
  assert.match(html(), /建个房间/, '应当还留在首页');
});

/* ───────────────────── 异常路径 ───────────────────── */

test('邀请码是坏的，给一句人话而不是白屏', async () => {
  const guest = boot({ BroadcastChannel: makeBus(), hash: '#o=这不是一个合法的包' });
  await until(() => /用不了|出错/.test(guest.html()));
  assert.match(guest.html(), /用不了/);
});

test('浏览器不支持 WebRTC 时，拿着邀请码进来也有话说', () => {
  assert.match(bootNoRtc('#o=zABC'), /不支持点对点联机/);
});

/* ───────────────────── 你画我猜：画布与输入框 ───────────────────── */

/** 起一局你画我猜，并把房间凑到 3 个人（界面本身没有加人的操作，只能从后门塞） */
function drawRoom(){
  const page = boot();
  page.click({ t:'create', name:'小明' });
  const c = page.ctrl();
  for (const n of ['小红','小刚']) c.room.members.push(page.GP.makeMember({ name:n }));
  page.click({ t:'start', game:'drawguess' });
  return { ...page, c };
}

test('★ 你画我猜：外壳真的会在画布挂上去之后调 afterRender —— 否则画布永远是白的', () => {
  const { c, dom, click, html, GP } = drawRoom();
  assert.ok(dom.canvases.length > 0, 'afterRender 压根没被调到');
  assert.match(html(), /<canvas/);

  const cv = dom.canvases.at(-1);
  assert.ok(cv.handlers.pointerdown, '房主就是画的人，画布上应当挂上指针事件');

  // 拖一笔再抬笔 —— 提交的应当是一条画完的线
  cv.handlers.pointerdown[0]({ clientX:0, clientY:0 });
  cv.handlers.pointermove[0]({ clientX:150, clientY:300 });
  assert.equal(c.room.mounted.state.strokes.length, 0, '手指还在动，不该已经发出去');
  cv.handlers.pointerup[0]({});
  assert.equal(c.room.mounted.state.strokes.length, 1);
  assert.deepEqual(c.room.mounted.state.strokes[0].points,
                   [{ x:0, y:0 }, { x:0.5, y:1 }], '坐标要归一化');

  // 提交会触发重渲染，画布得重新挂一次，不然第二笔就没地方画了
  assert.ok(dom.canvases.length > 1, '重渲染之后要重新挂画布并重画已有的线');
  assert.ok(dom.canvases.at(-1).handlers.pointerdown);
  assert.ok(GP.GAME_PLUGINS.some(p => p.id === 'drawguess'));
});

test('你画我猜：画完一笔，画笔颜色不该自己弹回去', () => {
  const { c, dom, click } = drawRoom();
  click({ t:'sel', k:'dgColor', v:'#ff6b6b' });
  assert.match(dom.byId.app.innerHTML, /class="dgcolor on"\s+style="background:#ff6b6b"/);

  const cv = dom.canvases.at(-1);
  cv.handlers.pointerdown[0]({ clientX:0, clientY:0 });
  cv.handlers.pointermove[0]({ clientX:10, clientY:10 });
  cv.handlers.pointerup[0]({});

  assert.equal(c.room.mounted.state.strokes[0].color, '#ff6b6b', '这一笔要用选中的颜色');
  assert.match(dom.byId.app.innerHTML, /class="dgcolor on"\s+style="background:#ff6b6b"/,
               '颜色是「用完还得留着」的那一类，画一笔不该把它重置掉');
});

test('★ 你画我猜：正在打的字不会被一次重渲染抹掉，提交时跟着动作一起走', () => {
  const { c, dom, click, type, html } = drawRoom();
  const hostId = c.me.id;

  // 第 1 轮画的是房主。放弃再下一轮，把笔交给别人，房主这边才会出现猜词框
  c.applyAs(hostId, { t:'giveUp' });
  c.applyAs(hostId, { t:'next' });
  assert.ok(dom.byId.dgGuess, '房主这边应当出现猜词框了');

  type('dgGuess', '冰淇淋');
  click({ t:'sel', k:'__noop', v:1 });        // 借一次无害操作逼出一次重渲染
  assert.match(html(), /value="冰淇淋"/, '重渲染把正在打的字抹掉了');

  // 「data-act 里的 textFrom」是界面层的事，不该跟着动作过线
  const seen = [];
  const orig = c.submit.bind(c);
  c.submit = (a) => { seen.push(a); return orig(a); };

  click({ t:'guess', textFrom:'dgGuess' });
  const st = c.room.mounted.state;
  assert.equal(st.guesses.length, 1);
  assert.equal(st.guesses[0].text, '冰淇淋', '输入框里的字要跟着动作一起提交');
  assert.equal(st.guesses[0].by, hostId, '记在提交的那个人头上');
  assert.equal('textFrom' in seen[0], false, '元素 id 没理由进动作里');
  assert.doesNotMatch(html(), /value="冰淇淋"/, '提交完输入框该空了');
});

test('你画我猜：猜词框上按回车就算提交 —— 手机上不该逼人去够那个按钮', () => {
  const { c, click, type, press } = drawRoom();
  const hostId = c.me.id;
  c.applyAs(hostId, { t:'giveUp' });
  c.applyAs(hostId, { t:'next' });

  type('dgGuess', '一个不对的词');
  press('dgGuess');
  assert.equal(c.room.mounted.state.guesses.length, 1);
  assert.equal(c.room.mounted.state.guesses[0].text, '一个不对的词');

  // 空着敲回车不该发出去 —— 不然就是往公屏上扔一条空猜测
  type('dgGuess', '   ');
  press('dgGuess');
  assert.equal(c.room.mounted.state.guesses.length, 1, '空猜测不该提交');
});

test('你画我猜：猜对了屏幕上就亮出答案', () => {
  const { c, dom, click, type, html } = drawRoom();
  const hostId = c.me.id;
  c.applyAs(hostId, { t:'giveUp' });
  c.applyAs(hostId, { t:'next' });
  const word = c.room.mounted.state.word;

  type('dgGuess', word);
  click({ t:'guess', textFrom:'dgGuess' });

  assert.equal(c.room.mounted.state.step, 'result');
  assert.match(html(), /答案是/);
  assert.ok(html().includes(word), '结算了就得把答案摆出来');
  assert.match(html(), /下一轮/);
});

test('你画我猜：换游戏时连 uiKeep 的画笔颜色一起清掉', () => {
  const { c, dom, click, html } = drawRoom();
  click({ t:'sel', k:'dgColor', v:'#ff6b6b' });

  click({ t:'switch', game:'dice' });
  click({ t:'switch', game:'drawguess' });
  assert.match(html(), /class="dgcolor on"\s+style="background:#ffffff"/,
               '换了一圈回来，画笔颜色应当是默认色，而不是上一局的残留');
});

/* ─────────────── 掉线：房间页的「有人不在了？」 ─────────────── */

test('房间页有「有人不在了？」入口，点开是浮层，关掉不留东西', () => {
  const { c, click, html } = drawRoom();
  assert.match(html(), /有人不在了？/, '房主该看得到这个入口');

  click({ t:'openSkip' });
  assert.match(html(), /class="overlay"/);
  assert.match(html(), /替他走这一步/);

  click({ t:'closeSkip' });
  assert.doesNotMatch(html(), /class="overlay"/, '关掉之后浮层不该留在页面上');
});

test('★ 浮层把「跳过后会变成什么样」写在按钮旁边，用 summarize 的统一说法', () => {
  const { c, click, html } = drawRoom();
  const drawer = c.room.mounted.state.players[c.room.mounted.state.drawerIdx];
  const drawerName = c.room.members.find(m => m.id === drawer).name;

  click({ t:'openSkip' });
  // 跳画的人 = 这一轮没人猜出来，跟历史记录里那一行是同一套说法
  assert.match(html(), /现在跳过他 → 第 1 轮没人猜出来/);
  assert.ok(html().includes(drawerName));
});

test('★ 没卡住的人按钮是置灰的 —— 不能让人按一个什么都不会发生的按钮', () => {
  const { c, click, html } = drawRoom();
  const st = c.room.mounted.state;
  const idle = c.room.members.find(m => m.id !== st.players[st.drawerIdx]);

  click({ t:'openSkip' });
  const rows = html().split('<div class="preset">').slice(1);
  const row = rows.find(r => r.includes(idle.name));
  assert.ok(row, '浮层里该有这个人的一行');
  assert.match(row, /现在没卡住什么/);
  assert.match(row, /disabled/, '★ 跳不出任何结果的按钮必须置灰');
});

test('★ 点「跳过」真的发出 skipPlayer，而且跳完浮层就关了', () => {
  const { c, click, html } = drawRoom();
  const st = c.room.mounted.state;
  const drawer = st.players[st.drawerIdx];

  click({ t:'openSkip' });
  click({ t:'skipPlayer', id: drawer });

  assert.equal(c.room.mounted.state.step, 'result', '跳过该真的落到局面上了');
  assert.doesNotMatch(html(), /class="overlay"/, '跳完该把浮层收起来');
});

test('不是房主就没有这个入口 —— 跳过是房主的权柄', () => {
  const { c, click, html } = drawRoom();
  c.me = c.room.members[1];              // 假装本端是加入端
  click({ t:'sel', k:'x', v:1 });        // 随便动一下触发重渲染
  assert.doesNotMatch(html(), /有人不在了？/, '加入端不该看得到、更加按不动');
});

test('没有「轮到谁」这回事的游戏，浮层老实说不用跳', () => {
  const { click, html } = drawRoom();
  click({ t:'switch', game:'dice' });
  click({ t:'openSkip' });
  assert.match(html(), /没有「轮到谁」这回事/);
});

test('换游戏时浮层收掉 —— 谁卡住了是上一局的事', () => {
  const { click, html } = drawRoom();
  click({ t:'openSkip' });
  assert.match(html(), /class="overlay"/);
  click({ t:'switch', game:'dice' });
  assert.doesNotMatch(html(), /class="overlay"/);
});
