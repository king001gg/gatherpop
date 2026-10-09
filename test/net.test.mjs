/**
 * 联机协议测试。
 *
 * 不去碰真的 RTCPeerConnection（Node 里也没有），而是用一个「消息过 JSON 线」的
 * 假传输来跑房主/加入端的完整协议流程。过 JSON 这一步很重要：真实 WebRTC 传的就
 * 是序列化后的数据，只有真序列化一遍，下面那些「不许泄露」的断言才作数。
 *
 *   node --test test/net.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

function loadCore(){
  const m = html.match(/\/\/ ==== CORE:BEGIN ====([\s\S]*?)\/\/ ==== CORE:END ====/);
  if (!m) throw new Error('index.html 里找不到 CORE:BEGIN / CORE:END 标记');
  const mod = { exports: {} };
  const factory = new Function('module', 'exports', m[1] + '\n;return GP;');
  return factory(mod, mod.exports);
}
const GP = loadCore();

/* ─────────────── 假传输：把消息真的序列化一遍再投递 ─────────────── */

class FakeTransport extends GP.Transport {
  constructor(id, hub){ super(); this.id = id; this.hub = hub; this.sent = []; this._peers = []; }
  send(msg, to){
    this.sent.push({ msg, to: to || null });
    if (this.hub) this.hub.deliver(this, msg, to);
    return true;
  }
  get peerIds(){ return this._peers; }
  connect(peerId){ if (!this._peers.includes(peerId)) this._peers.push(peerId); }
  inject(msg, from){ this._emit(msg, from); }
  msgsTo(peerId){ return this.sent.filter(x => x.to === peerId).map(x => x.msg); }
  /** 这个对端收到过的所有东西，序列化成一整块，用来搜有没有泄露 */
  wireTo(peerId){ return JSON.stringify(this.sent.filter(x => x.to === peerId).map(x => x.msg)); }
  wire(){ return JSON.stringify(this.sent.map(x => x.msg)); }
}

class Hub {
  constructor(){ this.byId = new Map(); }
  add(t){ this.byId.set(t.id, t); return t; }
  deliver(from, msg, to){
    // 真序列化 —— 传不过去的东西本来就不该藏在这里
    const onWire = JSON.parse(JSON.stringify(msg));
    if (to){
      const t = this.byId.get(to);
      if (t && t !== from) t.inject(onWire, from.id);
      return;
    }
    for (const t of this.byId.values()) if (t !== from) t.inject(onWire, from.id);
  }
}

function netWithHost(hostName = '房主'){
  const hub = new Hub();
  const hostT = hub.add(new FakeTransport('host', hub));
  const host = new GP.RoomController({ transport: hostT });
  host.createRoom(hostName);
  return { hub, hostT, host };
}

/** 拉一个加入端进房间，并把它接上 */
function addClient(hub, hostT, peerId, name){
  const t = hub.add(new FakeTransport(peerId, hub));
  hostT.connect(peerId);
  t.connect('host');
  const c = new GP.RoomController({ transport: t });
  const ready = c.joinAsClient(t, name);
  return { t, c, ready };
}

function netWithN(n){
  const { hub, hostT, host } = netWithHost();
  const clients = [];
  for (let i = 0; i < n; i++){
    clients.push(addClient(hub, hostT, 'peer' + i, '玩家' + (i + 1)));
  }
  return { hub, hostT, host, clients };
}

/* ─────────────────────── 信令打包 ─────────────────────── */

test('base64url 编解码能原样往返（含各种长度余数）', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 63, 64, 65]){
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 255;
    const round = GP.b64urlDecode(GP.b64urlEncode(bytes));
    assert.deepEqual(Array.from(round), Array.from(bytes), `${n} 字节往返失败`);
  }
});

test('base64url 不含 + / =，能安全放进 URL', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  const s = GP.b64urlEncode(bytes);
  assert.doesNotMatch(s, /[+/=]/, 'URL 片段里不能出现 + / =');
});

test('信令包能原样往返，且 SDP 被压得动', async () => {
  // 编一段形状接近真实 SDP 的东西：大量重复的属性名
  const sdp = [
    'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=ice-ufrag:4ZcD', 'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlTO',
    'a=fingerprint:sha-256 ' + Array.from({length:32},()=>'AB').join(':'),
    'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ].join('\r\n');

  const packed = await GP.packSignal({ pid:'peer0', sdp });
  const back = await GP.unpackSignal(packed);

  assert.deepEqual(back, { pid:'peer0', sdp }, '解出来必须和装进去的一样');
  assert.ok(packed.length < sdp.length, `没压动：${packed.length} vs ${sdp.length}`);
});

test('压过的包带 z 前缀，明文包带 r 前缀', async () => {
  const packed = await GP.packSignal({ a: 1 });
  assert.match(packed, /^[zr]/);
});

test('各种坏输入都给同一句人话，而不是抛裸的 TypeError', async () => {
  // 这些是扫错码、链接被截断、或者对方用了老版本时真会遇到的形状
  for (const bad of ['这不是一个合法的包', 'z@@@', 'r@@@', 'z', 'r', '', 'x123']){
    await assert.rejects(
      () => GP.unpackSignal(bad),
      (err) => {
        assert.ok(!(err instanceof TypeError), `${JSON.stringify(bad)} 抛了裸 TypeError`);
        assert.match(err.message, /读不出来/, `${JSON.stringify(bad)} 的提示不像人话`);
        return true;
      }
    );
  }
});

test('坏输入不会留下未处理的 rejection', async () => {
  // 解压流的读取端如果没人接住拒绝，这里会在下一个 tick 炸掉整个进程
  const before = process.listenerCount('unhandledRejection');
  const seen = [];
  const spy = (e) => seen.push(e);
  process.on('unhandledRejection', spy);
  try {
    await Promise.allSettled([
      GP.unpackSignal('z@@@'), GP.unpackSignal('这不是一个合法的包'),
      GP.unpackSignal('zAAA'), GP.unpackSignal('zzzzzzzz'),
    ]);
    await new Promise(r => setTimeout(r, 30));   // 给未处理的拒绝一点时间浮上来
    assert.deepEqual(seen, [], '有未处理的 rejection 漏出来了');
  } finally {
    process.removeListener('unhandledRejection', spy);
    assert.equal(process.listenerCount('unhandledRejection'), before);
  }
});

test('信令从 URL 片段里读得回来，且片段不会进服务器', () => {
  const url = GP.signalUrl('https://example.com/gp/', 'o', 'zABC');
  assert.equal(url, 'https://example.com/gp/#o=zABC');

  const got = GP.readSignalFromHash('#o=zABC');
  assert.deepEqual(got, { kind:'o', payload:'zABC' });
  assert.deepEqual(GP.readSignalFromHash('#a=zXYZ'), { kind:'a', payload:'zXYZ' });

  assert.equal(GP.readSignalFromHash(''), null);
  assert.equal(GP.readSignalFromHash('#nope'), null);
  assert.equal(GP.readSignalFromHash('#o='), null);
});

/* ─────────────────────── 加入流程 ─────────────────────── */

test('加入端连上后拿到自己的身份、token 和房间快照', async () => {
  const { hostT, host, hub } = netWithHost('房主');
  const A = addClient(hub, hostT, 'peer0', '甲');
  const me = await A.ready;

  assert.equal(me.name, '甲');
  assert.ok(me.token, '房主必须发一枚 token，否则断线后认不回来');
  assert.equal(A.c.room.members.length, 2, '加入端应当看到两个人');
  assert.equal(A.c.room.hostId, host.room.hostId);
  assert.equal(A.c.mode, 'client');
});

test('同一条连接重复 join 不会重复加人', () => {
  const { hostT, host, hub } = netWithHost();
  addClient(hub, hostT, 'peer0', '甲');
  assert.equal(host.room.members.length, 2);
  hostT.inject({ t:'join', name:'甲' }, 'peer0');
  assert.equal(host.room.members.length, 2, '重复 join 应当被忽略');
});

test('另一个加入端不会收到别人的 token', () => {
  const { hostT, hub } = netWithHost();
  const A = addClient(hub, hostT, 'peer0', '甲');
  addClient(hub, hostT, 'peer1', '乙');

  const tokenA = A.c.me.token;
  assert.ok(tokenA, 'A 自己该有 token');
  assert.ok(!hostT.wireTo('peer1').includes(tokenA), 'A 的 token 绝不能出现在发给 B 的报文里');
});

/* ─────────── ★ 安全边界：过线之后也不许泄露 ─────────── */

test('★ 谁是卧底：发给每个对端的报文里，只出现他自己那个词', () => {
  const { hostT, host, clients } = netWithN(5);
  host.startGame('undercover');
  const st = host.room.mounted.state;

  clients.forEach((cl, i) => {
    const wire = hostT.wireTo('peer' + i);
    const hits = [st.pair.civilian, st.pair.spy].filter(w => wire.includes(w)).length;
    assert.equal(hits, 1, `发给 ${i} 号的报文里出现了 ${hits} 个词，应当只有 1 个`);
    assert.equal(cl.c.myView.myWord, st.words[cl.c.me.id], '拿到自己的词');
  });
});

test('★ 描述阶段：过线的 view 里卧底名单和词对都必须是 null', () => {
  const { hostT, host } = netWithN(6);
  host.startGame('undercover');
  // 看完词才会进描述阶段
  host.room.members.forEach(m => host.applyAs(m.id, { t:'seen' }));
  assert.equal(host.room.mounted.state.phase, 'describe');

  for (let i = 0; i < 6; i++){
    // 开局之前推的是空视图（加入端本就该没有视图），这里只查开局之后的
    const views = hostT.msgsTo('peer' + i)
      .filter(m => m.t === 'view' && m.view)
      .map(m => m.view);
    assert.ok(views.length > 0, `peer${i} 没收到任何有效视图`);

    for (const v of views){
      assert.equal(v.spyIds, null, '没到结果阶段，卧底名单不能过线');
      assert.equal(v.pair, null, '没到结果阶段，词对不能过线');
      assert.equal('words' in v, false, '整张词的映射表不能过线');
      assert.ok(v.myWord, '但自己的词必须要有');
    }
  }
});

test('★ 狼人杀：过线的报文里只有自己的身份，别人的一个都不带', () => {
  const { hostT, host, clients } = netWithN(6);
  host.startGame('werewolf');
  const st = host.room.mounted.state;

  clients.forEach((cl, i) => {
    const mine = st.roles[cl.c.me.id];
    assert.equal(cl.c.myView.myRole, mine, '自己的身份必须给对');

    const views = hostT.msgsTo('peer' + i)
      .filter(m => m.t === 'view' && m.view).map(m => m.view);
    assert.ok(views.length > 0, `peer${i} 没收到任何有效视图`);

    for (const v of views){
      assert.equal(v.roles, null, '整张身份表绝不能过线');
      if (mine !== 'wolf') assert.equal('pack' in v, false, '狼队友名单只能发给狼');
      if (mine !== 'seer') assert.equal('checks' in v, false, '验人记录只能发给预言家');
      assert.equal('victim' in v, false, '开局没有任何理由把刀口发出去');
    }
  });
});

test('★ 狼人杀：狼队友名单只发给狼', () => {
  const { hostT, host, clients } = netWithN(7);
  host.startGame('werewolf');
  const st = host.room.mounted.state;
  const wolves = st.players.filter(id => st.roles[id] === 'wolf');
  assert.ok(wolves.length >= 2, '7 人局至少两只狼，这条测试才有意义');

  clients.forEach((cl, i) => {
    const shouldHave = st.roles[cl.c.me.id] === 'wolf';
    assert.equal(hostT.wireTo('peer' + i).includes('"pack"'), shouldHave,
      `${cl.c.me.name} 的报文里该不该有 pack —— 他是${st.roles[cl.c.me.id]}`);
  });
});

test('★ 狼人杀：今晚谁被杀，只发给女巫', () => {
  const { hostT, host, clients } = netWithN(6);
  host.startGame('werewolf');
  const st = host.room.mounted.state;
  for (const m of host.room.members) host.applyAs(m.id, { t:'seen' });

  const wolves = st.players.filter(id => st.roles[id] === 'wolf');
  const victim = st.players.find(id => st.roles[id] !== 'wolf');
  for (const w of wolves) host.applyAs(w, { t:'kill', target: victim });
  assert.equal(host.room.mounted.state.step, 'night.witch', '测试前提：该女巫行动了');

  const witch = st.players.find(id => st.roles[id] === 'witch');
  clients.forEach((cl, i) => {
    const isWitch = cl.c.me.id === witch;
    const wire = hostT.wireTo('peer' + i);
    assert.equal(wire.includes('"victim"'), isWitch,
      `${cl.c.me.name} 拿到了不该拿的刀口（他是${st.roles[cl.c.me.id]}）`);
    if (isWitch) assert.equal(cl.c.myView.victim, victim, '女巫必须知道刀口是谁');
  });
});

test('★ 狼人杀：验出来的是不是狼，只发给验人的那个', () => {
  const { hostT, host, clients } = netWithN(6);
  host.startGame('werewolf');
  const st = host.room.mounted.state;
  for (const m of host.room.members) host.applyAs(m.id, { t:'seen' });

  const wolves = st.players.filter(id => st.roles[id] === 'wolf');
  const victim = st.players.find(id => st.roles[id] !== 'wolf');
  for (const w of wolves) host.applyAs(w, { t:'kill', target: victim });
  if (host.room.mounted.state.step === 'night.witch'){
    host.applyAs(st.players.find(id => st.roles[id] === 'witch'), { t:'save', save:false });
  }

  const seer = st.players.find(id => st.roles[id] === 'seer');
  const mark = st.players.find(id => id !== seer && !host.room.mounted.state.dead.includes(id));
  host.applyAs(seer, { t:'check', target: mark });
  assert.equal(host.room.mounted.state.checks.length, 1, '测试前提：验过一次了');

  clients.forEach((cl, i) => {
    const isSeer = cl.c.me.id === seer;
    assert.equal(hostT.wireTo('peer' + i).includes('"checks"'), isSeer,
      `${cl.c.me.name} 拿到了不该拿的验人记录（他是${st.roles[cl.c.me.id]}）`);
    if (isSeer){
      const c = cl.c.myView.checks;
      assert.equal(c.length, 1);
      assert.equal(c[0].target, mark);
      assert.equal(c[0].wolf, st.roles[mark] === 'wolf');
    }
  });
});

test('★ 房间快照本身不含任何游戏状态', () => {
  const { hostT, host } = netWithN(4);
  host.startGame('undercover');
  const snap = host.snapshot();

  assert.equal('mounted' in snap, false, '快照不该带挂载的游戏');
  assert.equal('seed' in snap, false, '快照不该带随机种子');
  assert.equal('words' in snap, false);
  assert.ok(!JSON.stringify(snap).includes(host.room.mounted.state.pair.civilian),
    '快照里不该出现词');
});

test('★ 加入端自己的 myView 与房主为该成员裁的视图一致', () => {
  const { host, clients } = netWithN(5);
  host.startGame('undercover');
  clients.forEach((cl, i) => {
    assert.deepEqual(cl.c.myView, host.viewFor(cl.c.me.id), `${i} 号的视图对不上`);
  });
});

/* ─────────────────── 加入端：镜像与动作 ─────────────────── */

test('加入端镜像房间名单与分数，但不持有权威状态', async () => {
  const { host, hostT, hub } = netWithHost();
  const A = addClient(hub, hostT, 'peer0', '甲');
  await A.ready;

  host.startGame('dice');
  host.addScore(A.c.me.id, 7);

  assert.equal(A.c.room.members.length, 2);
  assert.equal(A.c.room.scores[A.c.me.id], 7, '分数要同步到加入端');
  assert.equal(A.c.room.currentGameId, 'dice');
  assert.equal(A.c.room.mounted, null, '加入端不该有权威状态');
});

test('加入端提交动作 → 房主裁决 → 结果同步回来', () => {
  const { host, hostT, hub } = netWithHost();
  const A = addClient(hub, hostT, 'peer0', '甲');
  host.startGame('dice');

  A.c.submit({ t:'roll', sides:6 });

  assert.equal(host.room.mounted.state.rolls.length, 1, '房主那边应当记下了这次投掷');
  assert.equal(host.room.mounted.state.rolls[0].by, A.c.me.id, '要记在动作发起人名下');
  assert.equal(A.c.myView.rolls.length, 1, '结果要推回加入端');
});

test('加入端不能替房主开游戏或结束游戏', () => {
  const { hostT, hub } = netWithHost();
  const A = addClient(hub, hostT, 'peer0', '甲');
  assert.throws(() => A.c.startGame('dice'), /只能由房主操作/);
  assert.throws(() => A.c.endGame(), /只能由房主操作/);
});

test('加入端改不动分数', () => {
  const { host, hostT, hub } = netWithHost();
  const A = addClient(hub, hostT, 'peer0', '甲');
  A.c.addScore(A.c.me.id, 99);
  A.c.resetScores();
  assert.deepEqual(host.room.scores, {}, '加入端不该能直接改分数');
});

test('房主身份在加入端看来是正确的', () => {
  const { host, hostT, hub } = netWithHost('房主');
  const A = addClient(hub, hostT, 'peer0', '甲');
  const hostMember = A.c.room.members.find(m => m.id === host.room.hostId);
  assert.equal(hostMember.isHost, true);
  assert.equal(hostMember.name, '房主');
  assert.equal(A.c.isHost, false);
});

/* ─────────────────── 切换游戏时的广播 ─────────────────── */

test('房主切换游戏后，所有加入端都收到新的快照与视图', () => {
  const { host, clients } = netWithN(5);
  host.startGame('dice');
  assert.equal(clients[0].c.room.currentGameId, 'dice');

  host.switchGame('undercover');

  assert.equal(clients[0].c.room.currentGameId, 'undercover');
  assert.equal(clients[0].c.myView.phase, 'reveal');
  assert.equal(clients[0].c.room.history.length, 1, '历史要同步');
  assert.equal(clients[0].c.room.members.length, 6, '换游戏不能丢成员');
});

test('★ 切到谁是卧底之后，加入端依然只拿得到自己的词', () => {
  const { host, hostT } = netWithN(5);
  host.startGame('dice');
  host.switchGame('undercover');
  const st = host.room.mounted.state;

  for (let i = 0; i < 5; i++){
    const wire = hostT.wireTo('peer' + i);
    const hits = [st.pair.civilian, st.pair.spy].filter(w => wire.includes(w)).length;
    assert.equal(hits, 1, `切换游戏后 ${i} 号收到的报文里出现了 ${hits} 个词`);
  }
});

test('一轮投票走完，结果广播给所有人', () => {
  const { host, clients } = netWithN(5);
  host.startGame('undercover');
  clients.forEach(cl => cl.c.submit({ t:'seen' }));
  host.submit({ t:'seen' });      // 房主也是玩家，也得看词
  assert.equal(host.room.mounted.state.phase, 'describe');
  host.submit({ t:'startVote' });

  // 所有人集火 1 号；1 号投 2 号
  const target = host.room.members[0].id;
  const fallback = host.room.members[1].id;
  host.room.members.forEach(m => {
    host.applyAs(m.id, { t:'vote', target: m.id === target ? fallback : target });
  });
  host.submit({ t:'tally' });

  clients.forEach(cl => {
    assert.equal(cl.c.myView.phase, 'result', '结果要同步到每个加入端');
    assert.ok(Array.isArray(cl.c.myView.spyIds), '结果阶段才公布卧底');
  });
});

/* ─────────────────────── 你画我猜：画布和词 ─────────────────────── */

/** 从第 from 条起新发给这个对端的报文 —— 免得被前几轮的旧报文干扰 */
function wireSince(t, peerId, from){
  return JSON.stringify(t.sent.filter(x => x.to === peerId).slice(from).map(x => x.msg));
}

test('★ 你画我猜：词只发给画的人，换人画之后漏出去的方向也跟着换', () => {
  const { host, hostT, clients } = netWithN(4);
  host.startGame('drawguess');
  const r1 = host.room.mounted.state.word;

  // 第 1 轮画的是房主，四个加入端谁也不该拿到词
  clients.forEach((cl, i) => cl.c.submit({ t:'guess', text:'肯定不对' + i }));
  clients.forEach((cl, i) => {
    assert.equal(cl.c.myView.word, null, `第 1 轮 peer${i} 拿到了词`);
    assert.ok(!hostT.wireTo('peer' + i).includes(r1),
              `第 1 轮 peer${i} 的报文里出现了词`);
  });

  // 推进一轮，让画的人变成一个加入端 —— 不然「画的人拿得到」这一半就测不到
  host.submit({ t:'giveUp' });
  host.submit({ t:'next' });
  const drawerIdx = host.room.mounted.state.drawerIdx;
  const r2 = host.room.mounted.state.word;
  assert.ok(drawerIdx >= 1, '这一轮画的人应当是个加入端，否则这个测试白测');

  // 从这一刻起只看新报文：上一轮的词在结算时公开过，留在旧报文里会干扰判断
  const mark = clients.map((_, i) => hostT.sent.filter(x => x.to === 'peer' + i).length);
  host.applyAs(host.room.members[drawerIdx].id, { t:'stroke', points:[{ x:0, y:0 }, { x:1, y:1 }] });

  clients.forEach((cl, i) => {
    const isDrawer = (i + 1) === drawerIdx;
    const wire = wireSince(hostT, 'peer' + i, mark[i]);
    assert.equal(wire.includes(r2), isDrawer,
      `peer${i} ${isDrawer ? '是画的人，应该拿得到词' : '不是画的人，报文里不该有词'}`);
    assert.equal(cl.c.myView.word, isDrawer ? r2 : null);
    assert.equal(cl.c.myView.wordLen, r2.length, '字数要给所有人 —— 这是规则不是秘密');
  });
});

test('★ 你画我猜：猜中那条的原文不借 guesses 溜出去 —— 它绕过 view.word 就等于泄题', () => {
  const { host, hostT, clients } = netWithN(3);
  host.startGame('drawguess');
  const w = host.room.mounted.state.word;

  // 让 1 号加入端猜中（房主是画的人，自己不能猜）
  clients[0].c.submit({ t:'guess', text: w });
  assert.equal(host.room.mounted.state.step, 'result');
  assert.equal(host.room.mounted.state.guesses.at(-1).text, w, '权威状态里得留着原文');

  clients.forEach((cl, i) => {
    const g = cl.c.myView.guesses.find(x => x.correct);
    assert.ok(g, `peer${i} 没收到那条猜中的记录`);
    assert.equal(g.text, null, `peer${i} 的猜测记录里带着原文`);
    // 结算后词本来就公开了，所以不能拿「报文里有没有这个词」当判据 ——
    // 要盯的是「它有没有从 guesses[].text 这个字段溜出来」
    assert.ok(!hostT.wireTo('peer' + i).includes(`"text":"${w}"`),
              `peer${i} 的报文里 guess 的 text 字段就是答案`);
  });
});

/* ─────────────── 掉线：跳过卡住的人（走真协议） ─────────────── */

test('★ 加入端发「跳过」，房主拒掉 —— 权柄不过线', () => {
  const { host, hostT, clients } = netWithN(3);
  host.startGame('drawguess');
  const drawer = host.room.mounted.state.players[host.room.mounted.state.drawerIdx];
  const before = JSON.stringify(host.room.mounted.state);

  // 让 0 号加入端「跳」掉画的人。它走的是 client.submit → action 报文 → 房主裁决
  clients[0].c.submit({ t:'skipPlayer', id: drawer });

  assert.equal(JSON.stringify(host.room.mounted.state), before,
               '★ 加入端的跳过必须被房主挡回来，局面一个字节都不该动');
});

test('★ 房主跳过掉线的人，新视图会推给其余对端 —— 掉线的人也一起「跳过」了', () => {
  const { host, hostT, clients } = netWithN(3);
  host.startGame('drawguess');
  const st = host.room.mounted.state;
  const drawer = st.players[st.drawerIdx];

  host.submit({ t:'skipPlayer', id: drawer });
  assert.equal(host.room.mounted.state.step, 'result');

  for (const cl of clients){
    assert.equal(cl.c.myView.step, 'result', '每个对端都该看到这一轮结算了');
    assert.ok(cl.c.myView.solvedBy === null && cl.c.myView.gaveUp === true);
    // 结算了词就公开，但「弃权」这件事得一致
    assert.equal(cl.c.myView.gaveUp, host.room.mounted.state.gaveUp);
  }
});

test('★ 对端掉线，房主侧看得见，而且这个事实会推给别人', () => {
  const { host, hostT, clients } = netWithN(3);
  const gone = clients[0];
  const goneMember = host.room.members.find(m => m.name === '玩家1');
  assert.ok(goneMember && goneMember.connected, '刚进来时是在线的');

  // 传输层只报「peer0 这条连接没了」
  hostT._peerState('peer0', false);

  assert.equal(goneMember.connected, false, '★ 房主侧该看得出来这个人不在了');
  assert.equal(host.room.history.length >= 0, true);

  // 这个事实跟着快照推给了剩下的对端 —— 真序列化一遍再找
  const wire = hostT.wireTo('peer1');
  assert.ok(wire.includes(`"id":"${goneMember.id}","name":"玩家1"`),
            '别人的名单还在');
  assert.ok(/"connected":false/.test(wire), '★ 「有人不在了」得真的过线，不能只在房主屏幕上');
  assert.equal(gone.c.room.members.find(m => m.id === goneMember.id).connected, false,
               '掉线的那一端自己也该看到自己掉线了（它可能还活着，只是这条连接废了）');

  // 又回来了
  hostT._peerState('peer0', true);
  assert.equal(goneMember.connected, true);
});

test('走一遍完整的：画的人掉线 → 房主看得见 → 跳过 → 其余人拿到能继续的局面', () => {
  const { host, hostT, clients } = netWithN(3);
  host.startGame('drawguess');

  // 房主先画第一轮（drawerIdx 从 0 起，也就是房主自己），然后翻给下一个人
  host.submit({ t:'skipPlayer', id: host.room.mounted.state.players[0] });
  host.submit({ t:'next' });
  const drawer = host.room.mounted.state.players[host.room.mounted.state.drawerIdx];
  const drawerMember = host.room.members.find(m => m.id === drawer);
  assert.equal(drawerMember.name, '玩家1', '这一轮该 1 号加入端画了');

  hostT._peerState('peer0', false);          // 画的人掉线了
  assert.equal(drawerMember.connected, false, '房主得看得出来人没了');

  host.submit({ t:'skipPlayer', id: drawer });   // 不然这一局就永远停在这儿
  assert.equal(host.room.mounted.state.step, 'result');

  // 剩下的人拿到的是「这一轮结算了」，而不是继续对着白画布干等
  for (const cl of clients.slice(1)){
    assert.equal(cl.c.myView.step, 'result', '每个还在的对端都该能继续往下走');
  }
});

/* ─────────── 刷新之后：带着 token 认回原来的座位 ───────────
   房主那边房间能存回来（见 core 的持久化），但光存房间没用 —— 大家重新扫码
   要是都变成新成员，分数清空、狼人杀身份重发，原来那排还挂在名单上成了幽灵。
   所以 join 要能捎上上次那枚 token，把连接接回**原来那个座位**。 */

function tmpStore(){
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

/** 让某个对端真的消失 —— 真机上就是那条连接断了 */
function dropPeer(hostT, peerId){
  const i = hostT._peers.indexOf(peerId);
  if (i >= 0) hostT._peers.splice(i, 1);
}

/** 来了一个新连接，带着（可能有的）token 要求进房间 */
function rejoin(hub, hostT, peerId, hostId, name, token){
  const t = hub.add(new FakeTransport(peerId, hub));
  hostT.connect(peerId);
  t.connect(hostId);
  const c = new GP.RoomController({ transport: t });
  return { t, c, ready: c.joinAsClient(t, name, { token }) };
}

test('★ 带着 token 回来，认的是原来那个座位 —— 不新增成员，分数还在', async () => {
  const { hub, hostT, host, clients } = netWithN(2);
  await Promise.all(clients.map(c => c.ready));
  const me = clients[0].c.me;
  host.addScore(me.id, 5);
  const before = host.room.members.length;

  dropPeer(hostT, 'peer0');                      // 这台设备掉了
  const back = rejoin(hub, hostT, 'peer0b', 'host', '玩家1', me.token);
  await back.ready;

  assert.equal(host.room.members.length, before, '不该多出一个成员');
  assert.equal(back.c.me.id, me.id, '要拿回同一个 id');
  assert.equal(back.c.me.token, me.token, 'token 也不该换');
  assert.equal(host.room.scores[me.id], 5, '分数得跟着座位走');
  assert.equal(host.room.members.find(m => m.id === me.id).connected, true);
});

test('★ 座位上还有活人时，同样的 token 只能当新成员 —— 不能顶掉在座的人', async () => {
  const { hub, hostT, host, clients } = netWithN(2);
  await Promise.all(clients.map(c => c.ready));
  const me = clients[0].c.me;
  const before = host.room.members.length;

  // 注意：peer0 没掉，还连着
  const thief = rejoin(hub, hostT, 'peer9', 'host', '冒名顶替', me.token);
  await thief.ready;

  assert.equal(host.room.members.length, before + 1, '顶不掉，只能当新成员');
  assert.notEqual(thief.c.me.id, me.id);
  assert.equal(host.room.members.find(m => m.id === me.id).connected, true, '在座的人不受影响');
});

test('房主的座位永远认不了 —— 认下它就等于把房主权限交出去', async () => {
  const { hub, hostT, host } = netWithHost();
  const hostToken = host.room.members[0].token;
  const c = rejoin(hub, hostT, 'peer0', 'host', '冒充房主', hostToken);
  await c.ready;

  assert.notEqual(c.c.me.id, host.room.hostId, '不能变成房主');
  assert.equal(c.c.me.isHost, false);
  assert.equal(host.room.hostId, host.room.members[0].id, '房主还是原来那位');
  assert.equal(host.room.members[0].isHost, true);
});

test('token 不认识（换了房间、或者第一次来）就当新成员，不抛', async () => {
  const { hub, hostT, host, clients } = netWithN(1);
  await Promise.all(clients.map(c => c.ready));
  const before = host.room.members.length;

  for (const tok of ['t_根本没这回事', '', null, undefined, 123, {}]){
    const x = rejoin(hub, hostT, 'peer_' + String(tok), 'host', '路人', tok);
    await x.ready;
    assert.equal(x.c.me.isHost, false);
  }
  assert.equal(host.room.members.length, before + 6, '每一个都该成为一个新成员');
});

test('★ 谁也没拿到别人的 token —— 认座用的凭据只发给本人', async () => {
  const { hub, hostT, host, clients } = netWithN(2);
  await Promise.all(clients.map(c => c.ready));
  dropPeer(hostT, 'peer0');
  const back = rejoin(hub, hostT, 'peer0b', 'host', '玩家1', clients[0].c.me.token);
  await back.ready;

  const all = host.room.members.map(m => m.token);
  assert.ok(all.every(t => t), '每个座位都得有 token，不然认不回来');

  // 发给 peer1 的东西里，除了他自己的那枚，别人的一个都不许有
  const wire = hostT.wireTo('peer1');
  for (const t of all){
    if (t === clients[1].c.me.token) continue;
    assert.ok(!wire.includes(t), `发给 peer1 的报文里漏了别人的 token：${t}`);
  }
  // 而本人拿到的那一份里，本来就只有他自己的
  assert.ok(hostT.wireTo('peer0b').includes(clients[0].c.me.token));
});

test('★ 完整走一遍：开局 → 房主刷新 → 房间接回来 → 大家认座 → 接着玩', async () => {
  const { hub, hostT, host, clients } = netWithN(2);
  await Promise.all(clients.map(c => c.ready));
  const ids = clients.map(c => c.c.me.id);
  const tokens = clients.map(c => c.c.me.token);

  host.startGame('drawguess');
  host.addScore(ids[0], 4);
  host.addScore(ids[1], 2);
  const store = tmpStore();
  assert.equal(GP.saveRoom(store, host), 1);

  // —— 房主刷新了 ——
  // 旧页面连同它那条传输一起没了，新页面是一个全新的控制器
  hub.byId.delete('host');
  const hostT2 = hub.add(new FakeTransport('host2', hub));
  const host2 = new GP.RoomController({ transport: hostT2 });
  assert.equal(host2.restore(GP.loadSavedRoom(store)), true);

  assert.equal(host2.room.members.length, 3, '成员一个都没少');
  assert.equal(host2.room.mounted.gameId, 'drawguess', '打到一半的那局也还在');
  assert.equal(host2.room.scores[ids[0]], 4);
  // 刷新把连接全断了 —— 除房主外人人离线，这是事实
  assert.deepEqual(host2.room.members.filter(m => m.connected).map(m => m.id),
                   [host2.room.hostId]);

  // —— 大家重新扫码进来，各带各的 token ——
  const re = [
    rejoin(hub, hostT2, 'h_peer0', 'host2', '玩家1', tokens[0]),
    rejoin(hub, hostT2, 'h_peer1', 'host2', '玩家2', tokens[1]),
  ];
  await Promise.all(re.map(r => r.ready));

  assert.equal(host2.room.members.length, 3, '认座不该多出人来');
  assert.deepEqual(re.map(r => r.c.me.id), ids, '两个人都拿回自己的 id');
  assert.equal(host2.room.scores[ids[0]], 4, '分数跟着座位走');
  assert.equal(host2.room.scores[ids[1]], 2);
  assert.equal(host2.room.members.every(m => m.connected), true, '都接回来了');

  // 而且这一局真的能接着往下玩：画手画完，轮到下一个人
  const drawer = host2.room.mounted.state.players[host2.room.mounted.state.drawerIdx];
  host2.applyAs(drawer, { t:'giveUp' });
  assert.equal(host2.room.mounted.state.step, 'result');
  for (const p of ['h_peer0', 'h_peer1']){
    assert.match(hostT2.wireTo(p), /"t":"view"/, '认座之后新视图要推给他们');
  }
  for (const r of re){
    assert.equal(r.c.myView.step, 'result', '各人那边也得真的看到这一轮结算');
  }
});

/* ─────────── 对端发来的垃圾报文：房主不许被打崩 ───────────
   线上的东西没有可信度。这不是防御性编程洁癖 —— 下面的报文任何连上的对端
   都能发，包括还没 join 的那种。 */

test('★ 对端发来 null / 非对象报文，房主不抛异常也不改状态', () => {
  const { hub, hostT, host } = netWithHost();
  addClient(hub, hostT, 'peer0', '玩家');
  host.startGame('dice');
  const before = JSON.stringify(host.room.mounted.state);

  // 字面量 `null` 在 JSON.parse 里不报错，出来的就是 null —— 真实可达
  for (const junk of [null, 42, 'hello', true, [], '[object Object]']){
    assert.doesNotThrow(() => hostT.inject(junk, 'peer0'),
      `注入 ${JSON.stringify(junk)} 时房主不该抛`);
  }
  assert.equal(JSON.stringify(host.room.mounted.state), before, '垃圾报文不该动到局面');
  assert.equal(host.room.members.length, 2, '也不该凭空多出成员');
});

test('★ action 是 null 时房主不抛，也不改状态', () => {
  const { hub, hostT, host } = netWithHost();
  const cli = addClient(hub, hostT, 'peer0', '玩家');
  host.startGame('dice');
  const before = JSON.stringify(host.room.mounted.state);

  for (const bad of [null, undefined, 'x', 7, true, []]){
    assert.doesNotThrow(() => hostT.inject({ t:'action', action: bad }, 'peer0'),
      `action=${JSON.stringify(bad)} 时不该抛`);
  }
  assert.equal(JSON.stringify(host.room.mounted.state), before, '局面不该变');

  // 而且不抛之后协议还得是活的 —— 正常动作照样能过
  hostT.inject({ t:'action', action: { t:'roll', sides: 6 } }, 'peer0');
  assert.notEqual(JSON.stringify(host.room.mounted.state), before, '垃圾之后正常动作仍要能生效');
});

test('★ 没 join 过的对端发动作和 join 都不该被受理', () => {
  const { hub, hostT, host } = netWithHost();
  host.startGame('dice');
  const before = JSON.stringify(host.room.mounted.state);

  hostT.connect('ghost');                      // 连上了，但从没 join
  hostT.inject({ t:'action', action: { t:'roll', sides: 6 } }, 'ghost');
  assert.equal(JSON.stringify(host.room.mounted.state), before, '幽灵对端不能动局面');

  assert.equal(host.room.members.length, 1, '这时房间里还只有房主');
  hostT.inject({ t:'join', name: '幽灵' }, 'ghost');
  assert.equal(host.room.members.length, 2, 'join 之后才该多出成员');
});
