/**
 * 扫码配对的传输层测试。
 *
 * Node 里没有 RTCPeerConnection，所以这里用一个假实现顶上。它不只是"记录调用"，
 * 而是真的把 SDP 在两端之间传一遍、真的把数据通道接起来 —— 这样跑的就是完整的
 * 邀请 → 回执 → 接通 → 入房流程，能抓到协议层面的错。
 *
 * 假的只是浏览器那部分；WebRtcTransport、打包、RoomController 全是真代码。
 *
 *   node --test test/pair.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FakePeerConnection, sessionHost, sessionClient, resetRtc } from './fake-rtc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const coreSrc = html.match(/\/\/ ==== CORE:BEGIN ====([\s\S]*?)\/\/ ==== CORE:END ====/)[1];
const netSrc  = html.match(/\/\/ ==== NET:BEGIN ====([\s\S]*?)\/\/ ==== NET:END ====/)[1];

/* ─────────────── 装载真正的代码 ─────────────── */

function boot(){
  const factory = new Function(
    'RTCPeerConnection', 'BroadcastChannel', 'location', 'setTimeout', 'clearTimeout',
    coreSrc + '\n' + netSrc + '\n;return { GP, WebRtcTransport, waitForIce, parseCandidates };'
  );
  return factory(FakePeerConnection, undefined, { origin:'https://x.test', pathname:'/' }, setTimeout, clearTimeout);
}

const { GP, WebRtcTransport, waitForIce, parseCandidates } = boot();

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

beforeEach(resetRtc);

/* ─────────────── 握手 ─────────────── */

test('邀请载荷里带着会话号和 SDP，且能被解回来', async (t) => {
  const host = new WebRtcTransport();
  const { peerId, payload } = await host.hostOffer();

  assert.match(peerId, /^p\d+$/);
  const back = await GP.unpackSignal(payload);
  assert.equal(back.pid, peerId, '回执要靠这个号找回是哪张邀请');
  assert.match(back.sdp, /^OFFER:/);
  host.close();
});

test('回执会把会话号原样带回来', async (t) => {
  const host = new WebRtcTransport();
  const client = new WebRtcTransport();

  const offer = await host.hostOffer();
  const answer = await client.clientAnswer(offer.payload);

  assert.equal(answer.peerId, offer.peerId, '回执必须能对上原始邀请');
  assert.match((await GP.unpackSignal(answer.payload)).sdp, /^ANSWER:/);
  host.close(); client.close();
});

test('走完一轮，两端都觉得连上了', async (t) => {
  const host = new WebRtcTransport();
  const client = new WebRtcTransport();

  const offer = await host.hostOffer();
  const answer = await client.clientAnswer(offer.payload);
  await host.hostAccept(answer.payload);
  await tick();

  assert.deepEqual(host.peerIds, [offer.peerId], '房主侧应当看到这个对端');
  assert.deepEqual(client.peerIds, ['host'], '加入端侧应当看到房主');
  host.close(); client.close();
});

test('数据通道打通时触发 onOpen', async (t) => {
  const host = new WebRtcTransport();
  const client = new WebRtcTransport();
  let opened = null;
  client.onOpen((id) => { opened = id; });

  const offer = await host.hostOffer();
  const answer = await client.clientAnswer(offer.payload);
  assert.equal(opened, null, '还没接上就不该触发');
  await host.hostAccept(answer.payload);
  await tick();

  assert.equal(opened, 'host');
  host.close(); client.close();
});

test('通道没开之前发的消息会排队，开了之后补发', async (t) => {
  const host = new WebRtcTransport();
  const client = new WebRtcTransport();

  const offer = await host.hostOffer();
  const answer = await client.clientAnswer(offer.payload);

  // 还没接上就发 —— 应当进队列而不是丢掉
  assert.equal(client.send({ t:'join', name:'甲' }), true);
  assert.equal(client._peers.get('host').open, false, '这会儿还不该是连上的');
  assert.equal(client._peers.get('host').queue.length, 1, '消息应当先排在队列里');

  await host.hostAccept(answer.payload);
  await tick();

  assert.equal(client._peers.get('host').open, true);
  assert.equal(client._peers.get('host').queue.length, 0, '开了队列就该清空');
  const got = client._peers.get('host').dc.sent.map(s => JSON.parse(s));
  assert.equal(got.length, 1, '排队的消息要补发出去');
  assert.equal(got[0].name, '甲');
  host.close(); client.close();
});

test('拿一张过期邀请来接，给人话错误而不是崩掉', async (t) => {
  const host = new WebRtcTransport();
  const other = new WebRtcTransport();

  const offer = await host.hostOffer();
  host.discard(offer.peerId);                     // 邀请作废
  const answer = await other.clientAnswer(offer.payload);

  await assert.rejects(() => host.hostAccept(answer.payload), /过期/);
  host.close(); other.close();
});

/* ─────────── 候选解析：真机排查全靠这个 ─────────── */

/** 一段形状真实的 SDP，含一个普通主机候选和一个 mDNS 假名候选 */
const SDP_WITH_CANDS = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=ice-ufrag:4ZcD', 'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlTO',
  'a=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 8f2a1c3e-4b5d-6e7f-8a9b-0c1d2e3f4a5b.local 54322 typ host generation 0',
  'a=candidate:3 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0',
  'a=end-of-candidates',
].join('\r\n');

test('候选解析：地址、端口、类型都挑得出来', async (t) => {
  const c = parseCandidates(SDP_WITH_CANDS);
  assert.equal(c.length, 3, '三个候选都该认出来');

  assert.equal(c[0].addr, '192.168.1.5');
  assert.equal(c[0].port, 54321);
  assert.equal(c[0].type, 'host');
  assert.equal(c[0].proto, 'udp');
  assert.equal(c[0].mdns, false, '真 IP 不是 mDNS');

  assert.equal(c[1].mdns, true, 'uuid.local 是 mDNS 假名');
  assert.equal(c[1].type, 'host');

  assert.equal(c[2].proto, 'tcp', 'TCP 候选也要认');
});

test('候选解析：认不出来的东西一律跳过，绝不让诊断自己崩', async (t) => {
  for (const bad of ['', null, undefined, 'v=0\r\n没别的了', 'a=candidate:1 1 udp\r\n']){
    assert.deepEqual(parseCandidates(bad), [], `${JSON.stringify(bad)} 应当安静地返回空`);
  }
});

test('候选解析：不会把 raddr 之类的尾巴当成候选', async (t) => {
  const c = parseCandidates(
    'a=candidate:1 1 udp 1 10.0.0.2 5000 typ srflx raddr 192.168.1.5 rport 54321\r\n');
  assert.equal(c.length, 1);
  assert.equal(c[0].type, 'srflx', 'typ 后面那格才是类型，别取成 raddr');
  assert.equal(c[0].addr, '10.0.0.2');
  assert.equal(c[0].mdns, false);
});

/* ─────────────── ICE 收集 ─────────────── */

test('状态本来就是 complete 时立刻放行', async (t) => {
  const pc = new FakePeerConnection({});
  pc.iceGatheringState = 'complete';
  const t0 = Date.now();
  await waitForIce(pc, 5000);
  assert.ok(Date.now() - t0 < 100, '不该白等超时');
});

test('收集一完成就放行，不用等满超时', async (t) => {
  const pc = new FakePeerConnection({});
  const t0 = Date.now();
  const waiting = waitForIce(pc, 5000);

  await tick(10);                                  // 模拟"收集了一会儿"
  pc.iceGatheringState = 'complete';
  for (const fn of pc._listeners.icegatheringstatechange || []) fn();
  await waiting;

  assert.ok(Date.now() - t0 < 1000, '状态一变就该返回，不该等满 5 秒');
});

test('收集卡住时超时兜底，不用干等', async (t) => {
  const pc = new FakePeerConnection({});
  const t0 = Date.now();
  await waitForIce(pc, 40);
  assert.ok(Date.now() - t0 >= 30, '应当等满超时时间才放行');
  assert.notEqual(pc.iceGatheringState, 'complete', '这台假 pc 根本没收集完');
});

test('收集超时也照样能生成邀请（拿手上已有的候选）', async (t) => {
  const host = new WebRtcTransport({ gatherTimeoutMs: 30 });
  const orig = FakePeerConnection.prototype.setLocalDescription;
  FakePeerConnection.prototype.setLocalDescription = async function(d){
    this.localDescription = d;
    await Promise.resolve();
    if (this.neverGather) return;
  };
  try {
    const offer = await host.hostOffer();
    host._peers.get(offer.peerId).pc.neverGather = true;
    assert.ok(offer.payload, '超时也要能出码');
  } finally {
    FakePeerConnection.prototype.setLocalDescription = orig;
  }
  host.close();
});

/* ─────────────── 接上 RoomController ─────────────── */

async function pairedRoom(t, { clip = 3 } = {}){
  const all = [];
  const newT = () => { const tr = new WebRtcTransport(); all.push(tr); return tr; };
  // 挂在测试上下文上：断言失败也不会漏掉清理（不然挂着的邀请定时器会拖住进程）
  t.after(() => { for (const tr of all) tr.close(); });

  const hostT = newT();
  const host = new GP.RoomController({ transport: hostT });
  host.createRoom('房主');

  // 房主之外再拉几个人进来，好凑够开局人数
  for (let i = 1; i < clip; i++){
    const t = newT();
    const c = new GP.RoomController({ transport: t });
    const ready = new Promise(res => t.onOpen(() => res(c.joinAsClient(t, '玩家' + i))));
    const offer = await hostT.hostOffer();
    await hostT.hostAccept((await t.clientAnswer(offer.payload)).payload);
    await ready;
  }

  const clientT = newT();
  const client = new GP.RoomController({ transport: clientT });
  const ready = new Promise(res => clientT.onOpen(() => res(client.joinAsClient(clientT, '甲'))));
  const offer = await hostT.hostOffer();
  await hostT.hostAccept((await clientT.clientAnswer(offer.payload)).payload);
  const me = await ready;

  return { hostT, host, clientT, client, me };
}

test('走真传输：加入端进得来，名单和身份都对', async (t) => {
  // clip:1 —— 房主之外只拉「甲」一个，房间里正好两个人
  const { hostT, host, client, me } = await pairedRoom(t, { clip: 1 });
  await tick();

  assert.equal(me.name, '甲');
  assert.ok(me.token, '断线重连要用');
  assert.equal(client.mode, 'client');
  assert.equal(client.room.members.length, 2);
  assert.equal(client.room.hostId, host.room.hostId);
  assert.equal(host.room.members.length, 2, '房主侧也应当多一个人');

});

test('走真传输：分数与游戏切换都同步得过去', async (t) => {
  const { hostT, host, client } = await pairedRoom(t);
  await tick();

  host.startGame('dice');
  await tick();
  assert.equal(client.room.currentGameId, 'dice');

  client.submit({ t:'roll', sides:6 });
  await tick();
  assert.equal(host.room.mounted.state.rolls.length, 1, '动作应当在房主那边裁决');
  assert.equal(host.room.mounted.state.rolls[0].by, client.me.id);
  assert.equal(client.myView.rolls.length, 1, '结果要推回来');

  host.addScore(client.me.id, 5);
  await tick();
  assert.equal(client.room.scores[client.me.id], 5);

});

test('走真传输：加入端改不动房主的东西', async (t) => {
  const { hostT, host, client } = await pairedRoom(t);
  await tick();

  assert.throws(() => client.startGame('dice'), /只能由房主操作/);
  client.addScore(client.me.id, 99);
  await tick();
  assert.deepEqual(host.room.scores, {}, '加入端不该能改分数');

});

/* ─────────── ★ 隐藏信息：过真通道也不许泄露 ─────────── */

test('★ 走真传输：谁是卧底的词，一个对端只拿得到一个', async (t) => {
  const { hostT, host } = await pairedRoom(t, { clip:5 });
  await tick();
  host.startGame('undercover');
  await tick();

  const st = host.room.mounted.state;
  for (const peerId of hostT.peerIds){
    const wire = JSON.stringify(hostT._peers.get(peerId).dc.sent);
    const hits = [st.pair.civilian, st.pair.spy].filter(w => wire.includes(w)).length;
    assert.equal(hits, 1, `发给 ${peerId} 的报文里出现了 ${hits} 个词，应当只有 1 个`);
  }

});

test('★ 走真传输：描述阶段卧底名单不出现在任何一条通道上', async (t) => {
  const { hostT, host } = await pairedRoom(t, { clip:5 });
  await tick();
  host.startGame('undercover');
  host.room.members.forEach(m => host.applyAs(m.id, { t:'seen' }));
  await tick();
  assert.equal(host.room.mounted.state.phase, 'describe');

  for (const peerId of hostT.peerIds){
    // 只查发出去的 view（快照里本来就没有游戏状态）
    const views = hostT._peers.get(peerId).dc.sent
      .map(s => JSON.parse(s))
      .filter(m => m.t === 'view' && m.view)
      .map(m => m.view);
    assert.ok(views.length > 0, `${peerId} 没收到任何有效视图`);

    for (const v of views){
      // 字段名在不在没关系（值是 null），要紧的是里头不能有东西
      assert.equal(v.spyIds, null, '卧底名单不能过线');
      assert.equal(v.pair, null, '词对不能过线');
      assert.equal('words' in v, false, '整张词的映射表不能过线');
      assert.ok(v.myWord, '但自己的词必须要有');
    }
  }
});

/* ─────────────── 断开 ─────────────── */

test('关掉传输会把所有连接清干净', async (t) => {
  const { hostT } = await pairedRoom(t);
  await tick();
  assert.ok(hostT.peerIds.length > 0, '先确认确实连上了');
  hostT.close();
  assert.deepEqual(hostT.peerIds, [], '关掉之后不该还有连接');
});

test('★ 数据通道断了，传输层要报出来 —— 房主侧才知道人没了', async (t) => {
  const { hostT, host, clientT } = await pairedRoom(t, { clip: 1 });
  await tick();

  const seen = [];
  hostT.onPeerState((id, ok) => seen.push([id, ok]));

  const peerId = hostT.peerIds[0];
  const meMember = host.room.members.find(m => m.name === '甲');
  assert.equal(meMember.connected, true, '刚连上时是在线的');

  // 对端那台设备锁屏/退出了。每端看到的是**自己这条** dc 关掉，
  // 假 RTC 里这两条 dc 没有互相通知，所以直接关房主这一侧的那条
  hostT._peers.get(peerId).dc.close();
  await tick();

  assert.ok(seen.some(([id, ok]) => id === peerId && ok === false),
            '★ 通道断了必须报出去，不然后面就是对着一个废连接干等');
  assert.equal(meMember.connected, false, '★ 房主侧的名单得如实反映这个人不在了');
});

test('同一状态不重复报 —— dc.onclose 和 pc 的连接状态会各响一次', async (t) => {
  const { hostT } = await pairedRoom(t, { clip: 1 });
  await tick();

  const seen = [];
  hostT.onPeerState((id, ok) => seen.push([id, ok]));
  const peerId = hostT.peerIds[0];

  hostT._peerState(peerId, false);
  hostT._peerState(peerId, false);       // 第二条路径再报一次同样的状态
  hostT._peerState(peerId, true);

  assert.deepEqual(seen, [[peerId, false], [peerId, true]]);
});
