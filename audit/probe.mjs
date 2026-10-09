/**
 * 企业级审计探针 —— 一次性跑完，打印发现的问题。
 * 不是正式测试，是「先打一遍看哪里漏水」的工具。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const m = html.match(/\/\/ ==== CORE:BEGIN ====([\s\S]*?)\/\/ ==== CORE:END ====/);
const mod = { exports: {} };
const GP = new Function('module', 'exports', m[1] + '\n;return GP;')(mod, mod.exports);

const findings = [];
function record(sev, area, title, detail, repro){
  findings.push({ sev, area, title, detail, repro });
}

/* ────────────────── 假传输（和 net.test.mjs 同款） ────────────────── */
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
  wire(){ return JSON.stringify(this.sent.map(x => x.msg)); }
  wireTo(peerId){ return JSON.stringify(this.sent.filter(x => x.to === peerId).map(x => x.msg)); }
}
class Hub {
  constructor(){ this.byId = new Map(); }
  add(t){ this.byId.set(t.id, t); return t; }
  deliver(from, msg, to){
    const onWire = JSON.parse(JSON.stringify(msg));
    if (to){ const t = this.byId.get(to); if (t && t !== from) t.inject(onWire, from.id); return; }
    for (const t of this.byId.values()) if (t !== from) t.inject(onWire, from.id);
  }
}

/** 起一个「N 人房 + n 个已连上的加入端」的完整现场 */
function scene(n){
  const hub = new Hub();
  const hostT = hub.add(new FakeTransport('host', hub));
  const host = new GP.RoomController({ transport: hostT });
  host.createRoom('房主');
  hostT.connect('peer0');
  const clients = [];
  for (let i = 0; i < n; i++){
    const peerId = 'peer' + i;
    const t = hub.add(new FakeTransport(peerId, hub));
    hostT.connect(peerId);
    t.connect('host');
    const c = new GP.RoomController({ transport: t });
    c.joinAsClient(t, '玩家' + i);
    clients.push({ t, c, peerId, member: host.room.members.find(x => x.name === '玩家' + i) });
  }
  return { hub, hostT, host, clients };
}

function tryCall(label, fn){
  try { const r = fn(); return { ok: true, value: r }; }
  catch (e){ return { ok: false, err: e }; }
}

/* ══════════════ 1. 协议健壮性：对端发垃圾报文，房主不许抛 ══════════════ */
{
  const bad = [
    ['null 报文', null],
    ['字符串报文', 'hello'],
    ['数字报文', 42],
    ['没有 t 字段', { foo: 1 }],
    ['t 是未知值', { t: 'rm -rf' }],
    ['t 是对象', { t: {} }],
    ['action 是 null', { t: 'action', action: null }],
    ['action 是字符串', { t: 'action', action: 'x' }],
    ['action 是数组', { t: 'action', action: [1,2,3] }],
    ['action.t 是对象', { t: 'action', action: { t: {} } }],
    ['action 是空对象', { t: 'action', action: {} }],
    ['join 的 name 是对象', { t: 'join', name: { a: 1 } }],
    ['join 的 name 是 null', { t: 'join', name: null }],
    ['join 的 name 是超长串', { t: 'join', name: 'x'.repeat(500000) }],
    ['join 的 name 是 __proto__', { t: 'join', name: '__proto__' }],
    ['join 的 token 是对象', { t: 'join', name: '正常', token: { evil: 1 } }],
    ['join 的 token 是超长串', { t: 'join', name: '正常', token: 'y'.repeat(100000) }],
    ['skipPlayer 缺 id', { t: 'action', action: { t: 'skipPlayer' } }],
  ];
  for (const [label, payload] of bad){
    const { hostT, host } = scene(1);
    host.startGame('dice');          // 必须挂着一局，否则 _applyAction 提前返回，测不出东西
    const r = tryCall(label, () => hostT.inject(payload, 'peer0'));
    if (!r.ok) record('中', '协议健壮性', `房主处理「${label}」时抛异常`, String(r.err && r.err.message), `hostT.inject(${JSON.stringify(payload)?.slice(0,60)}, 'peer0')`);
  }
}

/* ══════════════ 2. 授权：加入端不许越权 ══════════════ */
{
  const { hostT, host, clients } = scene(2);
  host.startGame('dice');
  const before = JSON.stringify(host.room.mounted.state);
  const peer0 = clients[0];

  // 假装是别人提交动作
  peer0.t.inject({ t: 'action', action: { t: 'roll', by: host.room.hostId } }, 'peer0');
  const after = JSON.stringify(host.room.mounted.state);
  if (before === after) {
    // 骰子谁都能滚，所以「没变化」也算过 —— 换个必须本人身份的动作来试
  }

  // 加入端想跳人
  const s2 = scene(6);
  s2.host.startGame('werewolf');
  const st = JSON.stringify(s2.host.room.mounted.state);
  s2.clients[0].t.inject({ t: 'action', action: { t: 'skipPlayer', id: s2.host.room.members[1].id } }, 'peer0');
  if (JSON.stringify(s2.host.room.mounted.state) !== st)
    record('高', '授权', '加入端能执行房主专属的 skipPlayer', '房间状态被改动', '客户端 inject skipPlayer');

  // 没 join 过的 peer 直接发动作
  const s3 = scene(1);
  s3.host.startGame('dice');
  s3.hostT.connect('ghost');
  const b3 = JSON.stringify(s3.host.room.mounted.state);
  s3.hostT.inject({ t: 'action', action: { t: 'roll' } }, 'ghost');
  if (JSON.stringify(s3.host.room.mounted.state) !== b3)
    record('高', '授权', '没 join 过的对端能提交动作', '幽灵 peer 影响了房间', "hostT.inject 从 'ghost'");

  // 加入端伪造 welcome/snapshot 影响自己
  const c0 = clients[0];
  c0.t.inject({ t: 'welcome', you: { id: 'x', name: 'hax', token: 't' }, snapshot: null }, 'host');
}

/* ══════════════ 3. XSS：成员名进入每一条渲染路径 ══════════════ */
{
  const evil = `<img src=x onerror=alert(1)>`;
  const { host } = scene(0);
  host.room.members.push(GP.makeMember({ name: evil }));
  host.startGame('dice');
  const ctx = { me: host.room.members[0], members: host.room.members, scores: {}, ui: {} };
  const games = ['dice','wheel','undercover','gacha','scoreboard','gomoku','chess','xiangqi','werewolf','drawguess'];
  for (const g of games){
    try {
      host.startGame(g);
    } catch { continue; }
    const p = GP.pluginById(g);
    const view = p.viewFor(host.room.mounted.state, host.room.members[0].id);
    const r = tryCall(g, () => p.render(view, { ...ctx, members: host.room.members }));
    if (!r.ok){ record('中', 'XSS', `${g} render 在恶意名字下抛异常`, String(r.err && r.err.message)); continue; }
    // 渲染结果里出现了未转义的原始标签
    if (typeof r.value === 'string' && r.value.includes('<img src=x onerror='))
      record('高', 'XSS', `${g} 渲染成员名时未转义`, '名字里的 HTML 原样进了 DOM', `名字 = ${evil}`);
  }
}

/* ══════════════ 4. viewFor 泄密矩阵 ══════════════ */
{
  // 谁是卧底：A 的视图里不许有 B 的词
  {
    const { host } = scene(0);
    for (const n of ['甲','乙','丙','丁','戊']) host.room.members.push(GP.makeMember({ name: n }));
    host.startGame('undercover', { preset: { pairs: [{ civilian: '飞机', spy: '火箭' }] } });
    const p = GP.pluginById('undercover');
    const st = host.room.mounted.state;
    const ids = host.room.members.map(x => x.id);
    // 找两个词不同的两个人
    const spyId = st.spyIds[0];
    const civId = ids.find(i => !st.spyIds.includes(i));
    const spyWord = st.words[spyId], civWord = st.words[civId];
    if (spyWord !== civWord){
      const civView = JSON.stringify(p.viewFor(st, civId));
      if (civView.includes(spyWord))
        record('严重', '泄密', '谁是卧底：平民视图里出现了卧底的词', `平民收到 ${spyWord}`, 'viewFor(state, 平民id)');
      // 结果阶段之前不许出现 spyIds
      if (st.phase !== 'result' && /"spyIds":\[/.test(civView) && !civView.includes('"spyIds":null'))
        record('严重', '泄密', '谁是卧底：结算前泄露了 spyIds', civView.slice(0, 200));
    } else {
      record('低', '泄密', '谁是卧底：本局平民与卧底词相同，泄密断言无效（测试自身问题）', `${civWord}==${spyWord}`);
    }
  }
  // 狼人杀：村民的视图里不许有 roles 表
  {
    const { host } = scene(0);
    for (const n of ['a','b','c','d','e','f']) host.room.members.push(GP.makeMember({ name: n }));
    host.startGame('werewolf');
    const p = GP.pluginById('werewolf');
    const st = host.room.mounted.state;
    const villager = st.players.find(id => st.roles[id] === 'villager');
    if (villager){
      const v = p.viewFor(st, villager);
      if (v.roles) record('严重', '泄密', '狼人杀：结算前把 roles 表发给了村民', JSON.stringify(v.roles));
      if (v.pack) record('严重', '泄密', '狼人杀：村民拿到了狼队名单', JSON.stringify(v.pack));
      const ser = JSON.stringify(v);
      const wolfName = '狼人';
      if (st.step !== 'over' && ser.includes('"myRole":"wolf"'))
        record('严重', '泄密', '狼人杀：村民视图里出现狼人角色', ser.slice(0, 200));
    }
    // 预言家的验人结果不许给别人
    const seer = st.players.find(id => st.roles[id] === 'seer');
    const other = st.players.find(id => st.roles[id] !== 'seer');
    if (seer && other){
      st.checks.push({ by: seer, target: other, wolf: false, round: 1 });
      const ov = JSON.stringify(p.viewFor(st, other));
      if (ov.includes('"checks"')) record('严重', '泄密', '狼人杀：验人结果发给了非预言家', ov.slice(0,200));
    }
    // 女巫的被害人信息
    const witch = st.players.find(id => st.roles[id] === 'witch');
    if (witch && st.step === 'night.witch'){
      const wv = p.viewFor(st, witch);
      const otherId = st.players.find(id => id !== witch);
      const otherView = JSON.stringify(p.viewFor(st, otherId));
      if (otherView.includes('"victim"') && st.night.victim)
        record('严重', '泄密', '狼人杀：被害者信息发给了非女巫', otherView.slice(0,200));
    }
  }
  // 你画我猜：猜对之前词不许出去
  {
    const { host } = scene(0);
    for (const n of ['a','b','c']) host.room.members.push(GP.makeMember({ name: n }));
    host.startGame('drawguess');
    const p = GP.pluginById('drawguess');
    const st = host.room.mounted.state;
    const drawer = st.players[st.drawerIdx];
    const guesser = st.players.find(i => i !== drawer);
    if (st.step !== 'result'){
      const gv = p.viewFor(st, guesser);
      if (gv.word) record('严重', '泄密', '你画我猜：词发给了猜的人', gv.word);
      const ser = JSON.stringify(gv);
      if (ser.includes(JSON.stringify(st.word).slice(1,-1)) && st.word && st.word.length > 1)
        record('严重', '泄密', '你画我猜：序列化后的视图里含答案', ser.slice(0,200));
      if (gv.wordLen !== (st.word||'').length) record('低', '界面', '你画我猜：wordLen 与真实词长不符', String(gv.wordLen));
    }
    // 猜对的那条猜测，文本不许出去
    const st2 = { ...st };
    const p2 = p;
    const fake = { ...st, guesses: [{ by: guesser, correct: true, text: st.word }] };
    const gv2 = JSON.stringify(p2.viewFor(fake, guesser));
    if (st.word && gv2.includes(`"text":"${st.word}"`))
      record('严重', '泄密', '你画我猜：猜对的那条猜测文本（=答案）被发出去', gv2.slice(0,200));
  }
}

/* ══════════════ 5. 纯函数性 / 确定性 ══════════════ */
{
  const games = ['dice','wheel','undercover','gacha','scoreboard','gomoku','chess','xiangqi','werewolf','drawguess'];
  for (const g of games){
    const { host } = scene(0);
    for (const n of ['a','b','c','d','e','f','g','h','i']) host.room.members.push(GP.makeMember({ name: n }));
    try { host.startGame(g, {}); } catch { continue; }
    const p = GP.pluginById(g);
    const st = host.room.mounted.state;
    const snapshotBefore = JSON.stringify(st);
    // 视图投影不许改动状态
    for (const mem of host.room.members) tryCall(g, () => p.viewFor(st, mem.id));
    if (JSON.stringify(st) !== snapshotBefore)
      record('中', '纯函数性', `${g} 的 viewFor 改动了 state`, '投影带副作用');
    // summarize 不许改状态
    if (typeof p.summarize === 'function'){
      tryCall(g, () => p.summarize(st));
      if (JSON.stringify(st) !== snapshotBefore)
        record('中', '纯函数性', `${g} 的 summarize 改动了 state`, '摘要带副作用');
    }
    // canApply / reduce 不许改状态
    tryCall(g, () => p.canApply(st, host.room.members[0].id, { t: '不存在的动作' }));
    if (JSON.stringify(st) !== snapshotBefore)
      record('中', '纯函数性', `${g} 的 canApply 改动了 state`, '裁决带副作用');
  }
  // 同一 seed 两次开局必须一模一样（成员 id 固定，否则差的是 id 不是随机性）
  for (const g of ['undercover','werewolf','drawguess','gacha']){
    const mk = () => {
      const c = new GP.RoomController({});
      c.createRoom('房主');
      c.room.members[0].id = 'm0';
      ['b','c','d','e','f','g'].forEach((n, i) => {
        const mm = GP.makeMember({ name: n }); mm.id = 'm' + (i + 1);
        c.room.members.push(mm);
      });
      c.room.seed = 12345;
      c.startGame(g);
      return JSON.stringify(c.room.mounted.state);
    };
    const a = tryCall(g, mk), b = tryCall(g, mk);
    if (a.ok && b.ok && a.value !== b.value)
      record('高', '确定性', `${g} 同 seed 两次开局结果不同`, '不可复现 —— 随机数没完全走 state.seed');
  }
}

/* ══════════════ 6. 持久化模糊测试 ══════════════ */
{
  function memStore(init){ const m = new Map(Object.entries(init || {}));
    return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k,v) => m.set(k, String(v)),
             removeItem: k => m.delete(k), _m: m }; }
  const junk = ['', '{', 'null', '[]', '"s"', '0', 'true', '{"v":1}',
    '{"v":1,"savedAt":1}', '{"v":1,"savedAt":1,"room":{}}',
    '{"v":1,"savedAt":1,"room":{"roomId":"a","hostId":"h","members":[]}}',
    '{"v":2,"savedAt":1e12,"room":{"roomId":"a","hostId":"h","members":[{"id":"h"}]}}',
    '{"v":1,"savedAt":"不是数字","room":{"roomId":"a","hostId":"h","members":[{"id":"h"}]}}',
    '{"v":1,"savedAt":1e12,"room":{"roomId":"a","hostId":"h","members":[{"id":"h"}],"mounted":{"gameId":"不存在","state":{}}}}',
    '{"v":1,"savedAt":1e12,"room":{"roomId":"a","hostId":"h","members":[{"id":"h"}],"mounted":{"gameId":"dice","state":"字符串不是对象"}}}',
    '{"v":1,"savedAt":1e12,"room":{"roomId":"a","hostId":"h","members":[{"id":"h"}],"currentGameId":"dice","mounted":null}}',
    '{"v":1,"savedAt":1e12,"room":{"roomId":"a","hostId":"h","members":[{"id":"h"}],"scores":"不是对象","history":"不是数组","phase":"playing"}}',
  ];
  for (const j of junk){
    const s = memStore({ [GP.ROOM_KEY]: j });
    const r = tryCall(j.slice(0,40), () => GP.loadSavedRoom(s));
    if (!r.ok) record('中', '持久化', `loadSavedRoom 对垃圾输入抛异常: ${j.slice(0,50)}`, String(r.err && r.err.message));
    else if (r.value && (!Array.isArray(r.value.room.members) || !r.value.room.members.length))
      record('高', '持久化', `loadSavedRoom 放行了一个没有成员的房间: ${j.slice(0,50)}`, JSON.stringify(r.value.room).slice(0,120));
    else if (r.value){
      // 放行之后必须能真的恢复
      const c = new GP.RoomController({});
      const rr = tryCall('restore', () => c.restore(r.value));
      if (!rr.ok) record('高', '持久化', `放行的存档 restore 时抛异常: ${j.slice(0,50)}`, String(rr.err && rr.err.message));
      else {
        const v = tryCall('view', () => c.myView);
        if (!v.ok) record('高', '持久化', `恢复后取视图抛异常: ${j.slice(0,50)}`, String(v.err && v.err.message));
      }
    }
  }
  // 存的时候存储抛异常
  {
    const c = new GP.RoomController({}); c.createRoom('房主');
    const boom = { getItem(){ throw new Error('quota'); }, setItem(){ throw new Error('quota'); }, removeItem(){ throw new Error('quota'); } };
    if (!tryCall('save', () => GP.saveRoom(boom, c)).ok) record('中', '持久化', 'saveRoom 在存储抛异常时未兜住', 'setItem 抛 → 函数也抛');
    if (!tryCall('load', () => GP.loadSavedRoom(boom)).ok) record('中', '持久化', 'loadSavedRoom 在存储抛异常时未兜住', 'getItem 抛 → 函数也抛');
    if (!tryCall('drop', () => GP.dropSavedRoom(boom)).ok) record('中', '持久化', 'dropSavedRoom 在存储抛异常时未兜住', 'removeItem 抛 → 函数也抛');
  }
  // 恶意存档：token 是房主那一枚
  {
    const c = new GP.RoomController({}); c.createRoom('房主');
    c.room.members.push(GP.makeMember({ name: '客' }));
    const saved = { v:1, savedAt: Date.now(), dropped:null, room: JSON.parse(JSON.stringify(c.room)) };
    const hack = JSON.parse(JSON.stringify(saved));
    // 让客人拿着房主的 token
    hack.room.members[1].token = hack.room.members[0].token;
    const c2 = new GP.RoomController({});
    const r = tryCall('restore', () => c2.restore(hack));
    if (!r.ok) record('中', '持久化', '篡改过的存档 restore 抛异常', String(r.err && r.err.message));
    else {
      // 房主自己的座位必须还在房主手里
      const hostT = new FakeTransport('h', null);
      const c3 = new GP.RoomController({ transport: hostT });
      c3.restore(hack);
      const claimed = c3._claimSeat({ token: hack.room.members[0].token, name: '冒充者' });
      if (claimed && claimed.id === c3.room.hostId)
        record('严重', '授权', '拿着房主 token 能认走房主的座位', '房主权限可被夺取', '_claimSeat({token: 房主token})');
      else if (claimed && claimed.id !== c3.room.hostId)
        record('低', '授权', '重复 token 时认到了第一个匹配的成员', '存档被篡改的场景，影响有限');
    }
  }
}

/* ══════════════ 7. 边界：人数上下限 ══════════════ */
{
  for (const p of GP.GAME_PLUGINS){
    if (p.minPlayers > 1){
      const c = new GP.RoomController({}); c.createRoom('房主');
      if (c.canStart(p.id)) record('低', '边界', `${p.id} 在 1 人时就能开局，但 minPlayers=${p.minPlayers}`, '下限没生效');
      let ok = false;
      try { c.startGame(p.id); } catch { ok = true; }
      if (!ok) record('高', '边界', `${p.id} 1 人时 startGame 没被拦住`, `minPlayers=${p.minPlayers}`);
    }
    if (p.maxPlayers > 0){
      const c = new GP.RoomController({}); c.createRoom('房主');
      for (let i = 0; i < p.maxPlayers + 3; i++) c.room.members.push(GP.makeMember({ name: 'x'+i }));
      if (c.canStart(p.id)) record('高', '边界', `${p.id} 超过 maxPlayers=${p.maxPlayers} 还能开局`, '上限没生效');
    }
  }
}

/* ══════════════ 输出 ══════════════ */
const order = { '严重':0, '高':1, '中':2, '低':3 };
findings.sort((a,b) => order[a.sev] - order[b.sev]);
if (!findings.length) console.log('\n没有发现问题。\n');
else {
  console.log(`\n发现 ${findings.length} 项：\n`);
  for (const f of findings){
    console.log(`[${f.sev}] ${f.area} — ${f.title}`);
    if (f.detail) console.log(`      详情: ${f.detail}`);
    if (f.repro) console.log(`      复现: ${f.repro}`);
    console.log();
  }
}
const tally = {};
for (const f of findings) tally[f.sev] = (tally[f.sev] || 0) + 1;
console.log('汇总:', JSON.stringify(tally));
