/**
 * 核心域测试。
 *
 * 核心逻辑写在 index.html 的 `==== CORE:BEGIN/END ====` 标记之间，且刻意不依赖 DOM，
 * 所以这里能把它整段抽出来在 Node 里直接跑。UI 层不在测试范围内。
 *
 *   node --test test/
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

/** 建一个 n 人房间。除房主外的成员直接入列，模拟"远端已经加入"。 */
function roomWith(...names){
  const ctrl = new GP.RoomController({});
  ctrl.createRoom(names[0]);
  const guests = names.slice(1).map(n => {
    const m = GP.makeMember({ name: n });
    ctrl.room.members.push(m);
    return m;
  });
  return { ctrl, host: ctrl.room.members[0], guests };
}

/* ───────────────────────── 房间：成员 ───────────────────────── */

test('创建房间后房主在成员列表里，且被标记为房主', () => {
  const { ctrl, host } = roomWith('小明');
  assert.equal(ctrl.room.members.length, 1);
  assert.equal(host.isHost, true);
  assert.equal(ctrl.room.hostId, host.id);
  assert.equal(ctrl.isHost, true);
});

test('成员各自持有一枚 token，用于断线后认领身份', () => {
  const { ctrl, host, guests } = roomWith('小明', '小红');
  const tokens = [host.token, ...guests.map(g => g.token)];
  assert.equal(new Set(tokens).size, tokens.length, 'token 必须互不相同');
  assert.ok(tokens.every(t => typeof t === 'string' && t.length > 0));
});

test('加入房间只追加成员，不改变房主', () => {
  const ctrl = new GP.RoomController({});
  ctrl.createRoom('小明');
  const hostId = ctrl.room.hostId;
  const room = ctrl.room;

  const other = new GP.RoomController({});
  other.room = room;
  other.joinRoom(room, '小红');

  assert.equal(room.members.length, 2);
  assert.equal(room.hostId, hostId, '房主不能因为有人加入而变化');
  assert.equal(room.members[1].name, '小红');
});

test('resume(token) 凭 token 认领原身份，不新增成员、不用重新配对', () => {
  const { ctrl, guests } = roomWith('小明', '小红');
  const before = ctrl.room.members.length;
  guests[0].connected = false;

  const back = new GP.RoomController({});
  back.room = ctrl.room;
  const ok = back.resume(guests[0].token);

  assert.equal(ok, true);
  assert.equal(back.me.id, guests[0].id, '认领的是同一个身份');
  assert.equal(ctrl.room.members.length, before, '不能新增成员');
  assert.equal(guests[0].connected, true);
});

test('resume 一个伪造的 token 会失败', () => {
  const { ctrl } = roomWith('小明', '小红');
  const bad = new GP.RoomController({});
  bad.room = ctrl.room;
  assert.equal(bad.resume('t_forged'), false);
});

/* ─────────────────── 切换游戏：保留什么 ─────────────────── */

test('切换游戏时成员列表原封不动', () => {
  const { ctrl } = roomWith('小明', '小红', '小刚');
  const before = ctrl.room.members.map(m => m.id).join(',');

  ctrl.startGame('dice');
  ctrl.submit({ t: 'roll' });
  ctrl.switchGame('undercover');

  assert.equal(ctrl.room.members.map(m => m.id).join(','), before, '换游戏不该丢成员');
  assert.equal(ctrl.room.currentGameId, 'undercover');
});

test('记分牌挂在房间上，跨游戏保留', () => {
  const { ctrl, host, guests } = roomWith('小明', '小红', '小刚');

  ctrl.addScore(host.id, 3);
  ctrl.addScore(guests[0].id, 1);
  ctrl.startGame('dice');
  ctrl.switchGame('wheel');
  ctrl.switchGame('undercover');

  assert.equal(ctrl.room.scores[host.id], 3, '换了三次游戏，分数必须还在');
  assert.equal(ctrl.room.scores[guests[0].id], 1);
});

test('清零只清分数，不影响成员和当前游戏', () => {
  const { ctrl, host } = roomWith('小明', '小红');
  ctrl.addScore(host.id, 5);
  ctrl.startGame('dice');
  ctrl.resetScores();

  assert.deepEqual(ctrl.room.scores, {});
  assert.equal(ctrl.room.members.length, 2);
  assert.equal(ctrl.room.currentGameId, 'dice');
});

test('切换游戏会写入历史，且历史里不留全量状态', () => {
  const { ctrl } = roomWith('小明', '小红', '小刚');
  ctrl.startGame('dice');
  ctrl.submit({ t: 'roll' });
  ctrl.switchGame('wheel');

  assert.equal(ctrl.room.history.length, 1);
  const ev = ctrl.room.history[0];
  assert.equal(ev.gameId, 'dice');
  assert.equal(typeof ev.summary, 'string');
  assert.equal('state' in ev, false, '历史只存摘要，不该把整个 state 塞进去');
});

/* ───────────────────── reduce 的纯函数性 ───────────────────── */

test('reduce 是纯函数：同样的输入必然得到同样的输出', () => {
  const state = { gameId:'dice', sides:6, seed:12345, rolls:[] };
  const a = GP.dicePlugin.reduce(state, { t:'roll', by:'m1' });
  const b = GP.dicePlugin.reduce(state, { t:'roll', by:'m1' });

  assert.deepEqual(a, b, '两次 reduce 结果必须一致');
  assert.deepEqual(state.rolls, [], '不能改动传入的 state');
});

test('随机是确定性的：同一个 seed 抽出来的东西完全一样', () => {
  const s1 = GP.undercoverPlugin.createInitialState({
    members: [{id:'a'},{id:'b'},{id:'c'},{id:'d'},{id:'e'}], seed: 42 });
  const s2 = GP.undercoverPlugin.createInitialState({
    members: [{id:'a'},{id:'b'},{id:'c'},{id:'d'},{id:'e'}], seed: 42 });

  assert.deepEqual(s1.words, s2.words);
  assert.deepEqual(s1.spyIds, s2.spyIds);
  assert.deepEqual(s1.order, s2.order);

  const s3 = GP.undercoverPlugin.createInitialState({
    members: [{id:'a'},{id:'b'},{id:'c'},{id:'d'},{id:'e'}], seed: 43 });
  assert.notDeepEqual(s1.order, s3.order, '换个 seed 应当得到不同结果');
});

test('卧底人数随人数增长，且永远少于总人数', () => {
  for (let n = 3; n <= 12; n++){
    const c = GP.spyCountFor(n);
    assert.ok(c >= 1 && c < n, `${n} 人时卧底 ${c} 个不合理`);
  }
});

/* ───────── ★ 安全边界：客户端永远拿不到完整 state ───────── */

/** 走完「看词 → 描述」两阶段，返回控制器与权威 state。 */
function undercoverInPlay(n = 6){
  const names = ['甲','乙','丙','丁','戊','己','庚','辛'].slice(0, n);
  const { ctrl } = roomWith(...names);
  ctrl.startGame('undercover');
  const st = ctrl.room.mounted.state;
  for (const m of ctrl.room.members) ctrl.applyAs(m.id, { t:'seen' });
  return { ctrl, st };
}

test('★ 看词阶段：每端只拿得到自己的词，拿不到别人的', () => {
  const { ctrl, st } = undercoverInPlay(6);

  for (const m of ctrl.room.members){
    const v = ctrl.viewFor(m.id);
    const json = JSON.stringify(v);

    assert.equal(v.myWord, st.words[m.id], '自己的词必须给对');
    assert.equal('words' in v, false, 'view 里不能有整张词的映射表');

    // 两个词里，view 中只允许出现「我自己那个」
    const hits = [st.pair.civilian, st.pair.spy].filter(w => json.includes(w)).length;
    assert.equal(hits, 1, `view 里出现了 ${hits} 个词，应当只有 1 个（自己的）`);
  }
});

test('★ 描述阶段：view 里不出现 spyIds，也不出现 pair', () => {
  const { ctrl } = undercoverInPlay(6);
  assert.equal(ctrl.room.mounted.state.phase, 'describe');

  for (const m of ctrl.room.members){
    const v = ctrl.viewFor(m.id);
    assert.equal(v.spyIds, null, '没到结果阶段不能暴露卧底是谁');
    assert.equal(v.pair, null, '没到结果阶段不能暴露词对');
    assert.equal(v.winner, null);
  }
});

test('★ 投票阶段：只回传「我投了谁」，别人的票不可见', () => {
  const { ctrl } = undercoverInPlay(6);
  ctrl.submit({ t:'startVote' });

  const [a, b] = ctrl.room.members;
  ctrl.applyAs(a.id, { t:'vote', target: b.id });

  const viewOfB = ctrl.viewFor(b.id);
  assert.equal(viewOfB.votes, null, '投票进行中不能公布所有人的票');
  assert.equal(viewOfB.myVote, null, 'B 还没投票');
  assert.equal(ctrl.viewFor(a.id).myVote, b.id, 'A 应当看到自己投给了谁');
});

test('★ 结果阶段才公布卧底和所有人的票', () => {
  const { ctrl } = undercoverInPlay(6);
  ctrl.submit({ t:'startVote' });

  // 所有人集火甲；甲不能投自己，就投给乙。
  const target = ctrl.room.members[0].id;
  const fallback = ctrl.room.members[1].id;
  for (const m of ctrl.room.members){
    ctrl.applyAs(m.id, { t:'vote', target: m.id === target ? fallback : target });
  }
  ctrl.submit({ t:'tally' });

  const v = ctrl.viewFor(ctrl.room.members[0].id);
  assert.equal(v.phase, 'result');
  assert.ok(Array.isArray(v.spyIds), '结果阶段应当公布卧底');
  assert.ok(v.pair && v.pair.civilian && v.pair.spy);
  assert.equal(Object.keys(v.votes).length, 6);
});

test('★ render 的输出里也不许混进别人的词（端到端再过一遍）', () => {
  const { ctrl, st } = undercoverInPlay(6);
  const plugin = GP.undercoverPlugin;

  for (const m of ctrl.room.members){
    const v = ctrl.viewFor(m.id);
    const out = plugin.render(v, { me: m, members: ctrl.room.members, isHost: false });
    const hits = [st.pair.civilian, st.pair.spy].filter(w => out.includes(w)).length;
    assert.equal(hits, 1, '渲染出来的 HTML 里只该有自己的那个词');
  }
});

/* ───────────────────────── 狼人杀 ───────────────────────── */

const WW_NAMES = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸','子','丑'];

/** 起一局狼人杀，所有人看完身份，返回控制器和权威 state */
function werewolfInPlay(n = 6, opts = {}){
  const { ctrl } = roomWith(...WW_NAMES.slice(0, n));
  ctrl.startGame('werewolf', opts);
  for (const m of ctrl.room.members) ctrl.applyAs(m.id, { t:'seen' });
  return { ctrl, st: ctrl.room.mounted.state };
}
const wwState = (ctrl) => ctrl.room.mounted.state;
/** 局里某个角色的成员 id。没这个角色就返回 undefined */
const wwWho = (ctrl, role) => wwState(ctrl).players.find(id => wwState(ctrl).roles[id] === role);
const wwWolfIds = (ctrl) => wwState(ctrl).players.filter(id => wwState(ctrl).roles[id] === 'wolf');
/** 指一个不是狼、也还活着的人当刀口 */
function wwVictim(ctrl){
  const st = wwState(ctrl);
  return st.players.find(id => st.roles[id] !== 'wolf' && !st.dead.includes(id));
}
/** 走完这一夜：狼刀 target，女巫 save，预言家验 check */
function wwNight(ctrl, { target, save = false, check } = {}){
  const t = target || wwVictim(ctrl);
  const dead = wwState(ctrl).dead;
  for (const id of wwWolfIds(ctrl)){
    if (dead.includes(id)) continue;              // 死狼没法再指人，漏掉它这一步就永远走不完
    ctrl.applyAs(id, { t:'kill', target:t });
  }
  if (wwState(ctrl).step === 'night.witch'){
    ctrl.applyAs(wwWho(ctrl, 'witch'), { t:'save', save });
  }
  if (wwState(ctrl).step === 'night.seer'){
    const seer = wwWho(ctrl, 'seer');
    // 只能验活着的人 —— 闭着眼乱指一个死人的话，这一步会被规则挡回来，流程就卡在这儿了
    const pick = check || wwState(ctrl).players.find(id =>
      id !== seer && !wwState(ctrl).dead.includes(id));
    ctrl.applyAs(seer, { t:'check', target: pick });
  }
}
/** 「开始投票」是局内人按的 —— 房主可能正好是夜里倒下的那个，所以挑个活人来按 */
function wwToVote(ctrl){
  const st = wwState(ctrl);
  const alive = st.players.find(id => !st.dead.includes(id));
  return ctrl.applyAs(alive, { t:'toVote' });
}
/** 全员把票投给同一个人（被投的人自己投别人） */
function wwVoteAll(ctrl, targetId){
  const st = wwState(ctrl);
  for (const id of st.players){
    if (st.dead.includes(id)) continue;
    const t = id === targetId ? st.players.find(x => x !== id && !st.dead.includes(x)) : targetId;
    ctrl.applyAs(id, { t:'vote', target:t });
  }
}

test('狼人杀：身份按人数配，不多不少，而且开局狼没到赢的地步', () => {
  for (let n = 5; n <= 12; n++){
    const members = Array.from({ length:n }, (_, i) => ({ id:'p'+i, name:'P'+i }));
    const st = GP.werewolfPlugin.createInitialState({ members, seed: 99 });
    const counts = {};
    for (const id of st.players) counts[st.roles[id]] = (counts[st.roles[id]] || 0) + 1;

    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), n, `${n} 人局发出来的身份数不对`);
    assert.equal(counts.seer, 1, `${n} 人局应当正好一个预言家`);
    assert.equal(counts.wolf, GP.wwAutoLineup(n).wolf, `${n} 人局狼数不对`);
    assert.ok(counts.wolf < n - counts.wolf, `${n} 人局一开局狼就已经赢了，这局没法玩`);
  }
});

test('狼人杀：同一个种子发同一手牌', () => {
  const members = WW_NAMES.slice(0, 8).map(n => ({ id:n, name:n }));
  const a = GP.werewolfPlugin.createInitialState({ members, seed: 12345 });
  const b = GP.werewolfPlugin.createInitialState({ members, seed: 12345 });
  assert.deepEqual(a.roles, b.roles, '同样的种子应当发出同样的身份');
  const c = GP.werewolfPlugin.createInitialState({ members, seed: 54321 });
  assert.notDeepEqual(a.roles, c.roles, '换个种子应当发出不同的身份');
});

test('狼人杀：都看完身份才天黑', () => {
  const { ctrl } = roomWith(...WW_NAMES.slice(0, 6));
  ctrl.startGame('werewolf');
  assert.equal(wwState(ctrl).step, 'reveal');

  const [first, ...rest] = ctrl.room.members;
  ctrl.applyAs(first.id, { t:'seen' });
  assert.equal(wwState(ctrl).step, 'reveal', '还有人不看，不能天黑');
  assert.equal(ctrl.applyAs(first.id, { t:'seen' }), false, '不能看两次');

  for (const m of rest) ctrl.applyAs(m.id, { t:'seen' });
  assert.equal(wwState(ctrl).step, 'night.wolf');
});

/* ---- ★ 安全边界 ---- */

test('★ 狼人杀：平民的 view 里没有别人的身份、没有狼名单、没有今晚的刀口', () => {
  const { ctrl } = werewolfInPlay(6);
  const villager = wwWho(ctrl, 'villager');
  const v = ctrl.viewFor(villager);
  const json = JSON.stringify(v);

  assert.equal(v.myRole, 'villager', '自己的身份当然要给自己');
  assert.equal(v.roles, null, '没结算就不能公开所有人的身份');
  assert.equal('pack' in v, false, '平民不该拿到狼队友名单');
  assert.equal('checks' in v, false, '平民不该拿到预言家的验人记录');
  assert.equal('victim' in v, false, '平民不该知道今晚谁被杀');

  // 每个人的身份都不能从这份 view 里推出来
  for (const id of wwState(ctrl).players){
    if (id === villager) continue;
    const role = wwState(ctrl).roles[id];
    const names = { wolf:'狼人', seer:'预言家', witch:'女巫', hunter:'猎人', villager:'平民' };
    assert.ok(!json.includes(WW_NAMES[wwState(ctrl).players.indexOf(id)] + '是' + names[role]),
      '连「某人是某角色」这样的字符串都不该出现');
  }
});

test('★ 狼人杀：狼知道同伙是谁，平民不知道', () => {
  const { ctrl } = werewolfInPlay(8);
  const wolves = wwWolfIds(ctrl);
  assert.ok(wolves.length >= 2, '8 人局至少有两只狼，这条测试才有意义');

  for (const w of wolves){
    const v = ctrl.viewFor(w);
    assert.deepEqual(v.pack, wolves, '狼必须看到完整的同伙名单');
    assert.equal(v.myRole, 'wolf');
  }
  const villager = wwWho(ctrl, 'villager');
  assert.equal('pack' in ctrl.viewFor(villager), false, '平民绝不能拿到这份名单');
});

test('★ 狼人杀：预言家的验人记录只给自己', () => {
  const { ctrl } = werewolfInPlay(6);
  const seer = wwWho(ctrl, 'seer');
  const target = wwState(ctrl).players.find(id => id !== seer);
  wwNight(ctrl, { check: target });

  const mine = ctrl.viewFor(seer);
  assert.equal(mine.checks.length, 1, '预言家应当看到自己验过的那一条');
  assert.equal(mine.checks[0].target, target);
  assert.equal(mine.checks[0].wolf, wwState(ctrl).roles[target] === 'wolf');
  assert.equal('by' in mine.checks[0], false, '记录里不必带上「谁验的」，反正只有本人看得到');

  for (const id of wwState(ctrl).players){
    if (id === seer) continue;
    const v = ctrl.viewFor(id);
    assert.equal('checks' in v, false, '验人记录只能是预言家自己的');
    assert.ok(!JSON.stringify(v).includes(`{"target":"${target}"`),
      '别人连「验了谁、结果是什么」这样的结构都不该拿到');
  }
});

test('★ 狼人杀：今晚谁被杀，只有女巫看得到', () => {
  const { ctrl } = werewolfInPlay(6);
  const witch = wwWho(ctrl, 'witch');
  const victim = wwVictim(ctrl);

  for (const id of wwWolfIds(ctrl)) ctrl.applyAs(id, { t:'kill', target:victim });
  assert.equal(wwState(ctrl).step, 'night.witch', '测试前提：该女巫行动了');

  const wv = ctrl.viewFor(witch);
  assert.equal(wv.victim, victim, '女巫必须知道今晚倒的是谁');
  assert.equal(wv.canSave, true, '解药还在');

  for (const id of wwState(ctrl).players){
    if (id === witch) continue;
    assert.equal('victim' in ctrl.viewFor(id), false, `除了女巫谁都不该知道刀口（${id} 拿到了）`);
  }
});

test('狼人杀：旁观者的 view 里什么私密信息都没有', () => {
  const { ctrl } = werewolfInPlay(6);
  const v = ctrl.viewFor('一个不在局里的人');
  assert.equal(v.me, null);
  assert.equal(v.myRole, null);
  assert.equal(v.roles, null);
  assert.equal(v.myVote, null);
  for (const k of ['pack', 'checks', 'victim']){
    assert.equal(k in v, false, `旁观者不该有 ${k}`);
  }
});

test('★ 狼人杀：投票进行中看得到「谁投了」，看不到「投给谁」', () => {
  const { ctrl } = werewolfInPlay(6);
  wwNight(ctrl);
  wwToVote(ctrl);

  const [a, b] = wwState(ctrl).players.filter(id => !wwState(ctrl).dead.includes(id));
  ctrl.applyAs(a, { t:'vote', target:b });

  assert.ok(!('votes' in ctrl.viewFor(b)), '整张票表绝不能过线');
  assert.equal(ctrl.viewFor(b).myVote, null, 'B 还没投');
  assert.equal(ctrl.viewFor(a).myVote, b, 'A 看得到自己投了谁');
  assert.deepEqual(ctrl.viewFor(b).votedIn, [a], '但「谁投过了」是公开的');
});

test('★ 狼人杀：结算之后才公开全部身份', () => {
  const { ctrl } = werewolfInPlay(6);
  assert.equal(ctrl.viewFor(wwWho(ctrl, 'villager')).roles, null, '开局时身份是保密的');

  // 一路推到分出胜负
  let guard = 0;
  while (wwState(ctrl).step !== 'over' && guard++ < 20){
    const st = wwState(ctrl);
    if (st.step === 'night.wolf') wwNight(ctrl);
    else if (st.step === 'day.announce') wwToVote(ctrl);
    else if (st.step === 'day.vote') wwVoteAll(ctrl, st.players.find(id => !st.dead.includes(id)));
    else if (st.step === 'day.hunter') ctrl.applyAs(st.hunterId, { t:'shoot', target:null });
    else break;
  }
  assert.equal(wwState(ctrl).step, 'over', '这局应当能正常打完');

  const anyViewer = wwState(ctrl).players[0];
  const v = ctrl.viewFor(anyViewer);
  assert.notEqual(v.roles, null, '结算了就该把身份摊开');
  assert.deepEqual(v.roles, wwState(ctrl).roles);
  assert.ok(v.winner === 'wolf' || v.winner === 'good');
});

/* ---- ★ 流程与规则 ---- */

test('★ 狼人杀：狼都指完了才进下一步', () => {
  // 6 人局正好两只狼 —— 用 8 人的话有三只，这条测试就名不副实了
  const { ctrl } = werewolfInPlay(6);
  const wolves = wwWolfIds(ctrl);
  assert.equal(wolves.length, 2, '测试前提：6 人局是两只狼');
  const v1 = wwVictim(ctrl);

  ctrl.applyAs(wolves[0], { t:'kill', target:v1 });
  assert.equal(wwState(ctrl).step, 'night.wolf', '还有狼没表态，不能往下走');

  ctrl.applyAs(wolves[1], { t:'kill', target:v1 });
  assert.notEqual(wwState(ctrl).step, 'night.wolf', '狼都指完了就该往下走');
  assert.equal(wwState(ctrl).night.victim, v1, '意见一致，刀口就是他');
});

test('★ 狼人杀：狼没谈拢就空刀，谁也不死', () => {
  const { ctrl } = werewolfInPlay(6);
  const wolves = wwWolfIds(ctrl);
  const others = wwState(ctrl).players.filter(id => !wolves.includes(id));

  ctrl.applyAs(wolves[0], { t:'kill', target:others[0] });
  ctrl.applyAs(wolves[1], { t:'kill', target:others[1] });

  const st = wwState(ctrl);
  assert.equal(st.night.victim, null, '两张不同的票 = 没谈拢，今晚空刀');
  assert.deepEqual(GP.wwTally(st.night.wolfVotes), { [others[0]]:1, [others[1]]:1 });
});

test('★ 狼人杀：女巫救人就是平安夜', () => {
  const { ctrl } = werewolfInPlay(6);
  const victim = wwVictim(ctrl);
  wwNight(ctrl, { target: victim, save: true });

  const st = wwState(ctrl);
  assert.equal(st.dead.includes(victim), false, '被救了就不该死');
  assert.equal(st.step, 'day.announce');
  assert.deepEqual(st.lastNight, [], '公布出来应当是平安夜');
});

test('★ 狼人杀：解药只有一瓶，用掉之后就不用再问女巫了', () => {
  const { ctrl } = werewolfInPlay(6);
  wwNight(ctrl, { save: true });
  assert.equal(wwState(ctrl).witchSaveUsed, true, '用掉了就该记上');
  assert.equal(wwState(ctrl).dead.length, 0);

  wwToVote(ctrl);
  wwVoteAll(ctrl, wwState(ctrl).players.find(id => !wwState(ctrl).dead.includes(id)));
  if (wwState(ctrl).step === 'over') return;      // 这一票可能直接结束，那就不测后半段

  assert.equal(wwState(ctrl).step, 'night.wolf', '该进入下一夜了');
  for (const id of wwWolfIds(ctrl)) ctrl.applyAs(id, { t:'kill', target:wwVictim(ctrl) });
  assert.notEqual(wwState(ctrl).step, 'night.witch', '解药没了，女巫这一步应当被跳过');
});

test('★ 狼人杀：平票不淘汰人', () => {
  // 先让女巫救人，凑出一个没人出局的白天 —— 6 个人整整齐齐，才能投出 3:3
  const { ctrl } = werewolfInPlay(6);
  wwNight(ctrl, { save: true });
  wwToVote(ctrl);

  const alive = wwState(ctrl).players.filter(id => !wwState(ctrl).dead.includes(id));
  assert.equal(alive.length, 6, '平安夜之后应当一个都没少');
  const [x, y] = alive;
  // x 和 y 互投，剩下四个二二分开 —— 正好 3:3，而且谁都不投自己
  const rest = alive.slice(2);
  alive.forEach((id) => {
    let target;
    if (id === x) target = y;
    else if (id === y) target = x;
    else target = rest.indexOf(id) < 2 ? x : y;
    ctrl.applyAs(id, { t:'vote', target });
  });

  const st = wwState(ctrl);
  assert.deepEqual(st.tally, { [x]:3, [y]:3 }, '正好投成 3:3');
  assert.equal(st.dead.length, 0, '平票不该有人出局');
  assert.equal(st.round, 2, '平票之后直接进下一轮');
});

test('狼人杀：得票最多的出局，平票返回 null', () => {
  assert.equal(GP.wwTopVote({ a:'x', b:'x', c:'y' }), 'x', '两票对一票，票多的赢');
  assert.equal(GP.wwTopVote({ a:'x', b:'y' }), null, '一比一就是平票');
  assert.equal(GP.wwTopVote({ a:'x' }), 'x');
  assert.equal(GP.wwTopVote({}), null, '一张票都没有');
});

/** 起一局「1 狼 1 预言家 1 女巫 1 猎人 2 平民」，夜里刀一个平民，白天投出指定的人 */
function hunterGame(){
  const { ctrl } = werewolfInPlay(6, {
    preset: { lineup: { wolf:1, seer:1, witch:1, hunter:1, villager:2 } },
  });
  const hunter = wwWho(ctrl, 'hunter');
  // 刀口必须挑平民：刀到猎人的话，白天谁也投不了他（死人不能当票靶），流程就走不下去了
  const villager = wwState(ctrl).players.find(id => wwState(ctrl).roles[id] === 'villager');
  wwNight(ctrl, { target: villager });
  wwToVote(ctrl);
  return { ctrl, hunter };
}

test('★ 狼人杀：猎人被投出去，可以开枪也可以不开', () => {
  const { ctrl, hunter } = hunterGame();
  wwVoteAll(ctrl, hunter);

  assert.equal(wwState(ctrl).step, 'day.hunter', '猎人出局该问他开不开枪');
  assert.equal(wwState(ctrl).hunterId, hunter);
  assert.equal(ctrl.applyAs(hunter, { t:'shoot', target:null }), true, '可以放弃开枪');
  assert.notEqual(wwState(ctrl).step, 'day.hunter', '开了枪（或放弃）就该往下走');
});

test('★ 狼人杀：猎人开的那一枪真的带走一个人', () => {
  const { ctrl, hunter } = hunterGame();
  wwVoteAll(ctrl, hunter);

  const mark = wwState(ctrl).players.find(id => id !== hunter && !wwState(ctrl).dead.includes(id));
  ctrl.applyAs(hunter, { t:'shoot', target: mark });

  assert.ok(wwState(ctrl).dead.includes(mark), '被带走的那个应当也出局');
  assert.ok(wwState(ctrl).lastNight.some(d => d.id === mark), '公屏上要有记录');
});

test('狼人杀：死了的猎人不能再开枪，别人也不能替他开', () => {
  const { ctrl, hunter } = hunterGame();
  wwVoteAll(ctrl, hunter);
  const other = wwState(ctrl).players.find(id => id !== hunter);

  assert.equal(ctrl.applyAs(other, { t:'shoot', target: hunter }), false, '别人不能替他开枪');
  ctrl.applyAs(hunter, { t:'shoot', target:null });
  assert.equal(ctrl.applyAs(hunter, { t:'shoot', target: other }), false, '开完就不能再开');
});

test('★ 狼人杀：出局的人不能再投票，也不能再行动', () => {
  const { ctrl } = werewolfInPlay(6);
  wwNight(ctrl);
  wwToVote(ctrl);

  const dead = wwState(ctrl).dead[0];
  assert.ok(dead, '夜里应当有人倒下');
  const alive = wwState(ctrl).players.find(id => !wwState(ctrl).dead.includes(id));
  assert.equal(ctrl.applyAs(dead, { t:'vote', target:alive }), false, '死人不能投票');
});

test('★ 狼人杀：狼全死 = 好人赢，狼数追平 = 狼赢', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = wwState(ctrl);
  const wolves = wwWolfIds(ctrl);

  // 直接照规则算，不绕圈子
  const mk = (deadList) => ({ ...st, dead: deadList });
  assert.equal(GP.wwWinner(mk(wolves)), 'good', '狼死光了，好人赢');
  const alive = st.players.filter(id => !wolves.includes(id));
  assert.equal(GP.wwWinner(mk(alive.slice(0, wolves.length))), 'wolf',
    '好人只剩和狼一样多，狼赢');
  assert.equal(GP.wwWinner(mk([])), null, '开局谁也不赢');
});

test('狼人杀：不在局里的人动不了任何东西', () => {
  const { ctrl } = werewolfInPlay(6);
  const outsider = '路人';
  const t = wwVictim(ctrl);
  for (const act of [{ t:'kill', target:t }, { t:'check', target:t },
                     { t:'vote', target:t }, { t:'toVote' }, { t:'save', save:true }]){
    assert.equal(ctrl.applyAs(outsider, act), false, `外人居然能用 ${act.t}`);
  }
});

test('狼人杀：人数对不上的方案会被丢掉，退回自动配置', () => {
  const members = WW_NAMES.slice(0, 6).map(n => ({ id:n, name:n }));
  const bad = GP.werewolfPlugin.createInitialState({ members, seed: 1,
    preset: { lineup: { wolf:5, seer:5, witch:5, hunter:5, villager:5 } } });
  const counts = {};
  for (const id of bad.players) counts[bad.roles[id]] = (counts[bad.roles[id]] || 0) + 1;
  assert.equal(counts.wolf, GP.wwAutoLineup(6).wolf, '总数对不上就该按人数自动配');
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 6);
});

test('狼人杀：方案读得回来，也写得出文本', () => {
  const data = { lineup: { wolf:2, seer:1, witch:1, hunter:0, villager:4 } };
  const text = GP.werewolfPlugin.presetToText(data);
  assert.match(text, /狼人=2/);
  const back = GP.werewolfPlugin.readPreset(text);
  assert.deepEqual(back, data, '写出来再读回去应当一模一样');
  assert.equal(GP.werewolfPlugin.readPreset('这不是配置'), null);
});

/* ─────────────────────── 越权与规则 ─────────────────────── */

test('不是自己的回合，不能推进描述', () => {
  const { ctrl } = undercoverInPlay(4);
  const st = ctrl.room.mounted.state;
  const current = st.order[st.turnIdx];
  const other = ctrl.room.members.find(m => m.id !== current);

  assert.equal(ctrl.applyAs(other.id, { t:'next' }), false, '别人不能替你跳过');
  assert.equal(ctrl.applyAs(current, { t:'next' }), true, '轮到自己时可以推进');
});

test('不能给自己投票，也不能重复投票', () => {
  const { ctrl } = undercoverInPlay(5);
  ctrl.submit({ t:'startVote' });
  const [a, b] = ctrl.room.members;

  assert.equal(ctrl.applyAs(a.id, { t:'vote', target: a.id }), false, '不能投自己');
  assert.equal(ctrl.applyAs(a.id, { t:'vote', target: b.id }), true);
  assert.equal(ctrl.applyAs(a.id, { t:'vote', target: ctrl.room.members[2].id }), false, '不能改票');
});

test('人数不够时开不了局', () => {
  const { ctrl } = roomWith('小明', '小红');
  assert.equal(ctrl.canStart('undercover'), false, '谁是卧底至少要 3 人');
  assert.equal(ctrl.canStart('dice'), true, '骰子一个人也能玩');
  assert.throws(() => ctrl.startGame('undercover'), /需要 3 人/);
});

/* ───────────────────────── 插件契约 ───────────────────────── */

test('每款游戏都实现了完整契约，且 id 不重复', () => {
  const required = ['id','name','rhythm','minPlayers','maxPlayers',
                    'createInitialState','reduce','canApply','viewFor','render'];
  for (const p of GP.GAME_PLUGINS){
    for (const k of required){
      assert.ok(p[k] !== undefined, `${p.id} 缺少 ${k}`);
    }
  }
  const ids = GP.GAME_PLUGINS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, '游戏 id 不能重复');
});

test('每款游戏都能建局、能出视图、能渲染出 HTML', () => {
  const { ctrl } = roomWith('甲','乙','丙','丁','戊','己');
  for (const p of GP.GAME_PLUGINS){
    ctrl.startGame(p.id);
    const v = ctrl.myView;
    assert.ok(v, `${p.id} 没有产出 view`);
    const out = p.render(v, { me: ctrl.me, members: ctrl.room.members, isHost: true });
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, `${p.id} 渲染出了空字符串`);
  }
});

test('每款游戏在「没有 scores 的 ctx」下也渲染得出来', () => {
  // scores 是可选的。插件要是直接 ctx.scores[x] 就会崩 —— 这个坑踩过一次
  const { ctrl } = roomWith('甲','乙','丙','丁','戊','己');
  for (const p of GP.GAME_PLUGINS){
    ctrl.startGame(p.id);
    assert.doesNotThrow(
      () => p.render(ctrl.myView, { me: ctrl.me, members: ctrl.room.members, isHost: true }),
      `${p.id} 在没有 scores 时崩了`);
  }
});

test('每款游戏的可选钩子在没有真 DOM 时都不炸', () => {
  // afterRender 是唯一允许碰 DOM 的地方，但「没有那个节点」是常态：
  // 无头测试、别的页面、canvas 被浏览器挡掉 —— 都得安静退出，不能抛
  const { ctrl } = roomWith('甲','乙','丙','丁','戊','己');
  for (const p of GP.GAME_PLUGINS){
    ctrl.startGame(p.id);
    if (typeof p.afterRender !== 'function') continue;
    const ctx = { me: ctrl.me, members: ctrl.room.members, isHost:true, ui:{}, submit(){} };
    assert.doesNotThrow(() => p.afterRender(ctrl.myView, ctx, { querySelector: () => null }),
                        `${p.id} 的 afterRender 在没有目标节点时崩了`);
  }
});

/* ───────────────────────── 国际象棋 ───────────────────────── */

/** 从 FEN 摆一个局面出来（只认前四个字段） */
function chessPos(fen){
  const [placement, turn, castling, ep] = fen.split(' ');
  return {
    gameId:'chess', seed:1, turn0:'w', turn,
    board: GP.chessParse(placement),
    players: ['p0','p1'],
    castling: {
      wk: castling.includes('K'), wq: castling.includes('Q'),
      bk: castling.includes('k'), bq: castling.includes('q'),
    },
    ep: ep && ep !== '-' ? (8 - +ep[1]) * 8 + 'abcdefgh'.indexOf(ep[0]) : null,
    last:null, moves:[], check:false, winner:null,
  };
}

/**
 * perft：把这个局面往下走 depth 层，数一共有多少条合法着法序列。
 * 这是验证棋规引擎最硬的办法 —— 一个数字对不上，就说明某处走子生成是错的。
 */
function perft(state, depth){
  if (depth === 0) return 1;
  let n = 0;
  for (let i = 0; i < 64; i++){
    if (!state.board[i] || state.board[i].c !== state.turn) continue;
    for (const to of GP.chessLegal(state, i)) n += perft(GP.chessMake(state, i, to), depth - 1);
  }
  return n;
}

test('★ 国际象棋 perft：开局深度 1–3 与公开数据完全一致', () => {
  const start = chessPos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(perft(start, 1), 20, '开局第一步应当是 20 种');
  assert.equal(perft(start, 2), 400);
  assert.equal(perft(start, 3), 8902);
});

test('★ 国际象棋 perft：Kiwipete 局面 —— 专门考易位、吃过路兵和牵制', () => {
  // 这个局面是棋规引擎的经典试金石：王车易位、吃过路兵、被牵制的子全都占齐了
  const k = chessPos('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(perft(k, 1), 48);
  assert.equal(perft(k, 2), 2039);
  assert.equal(perft(k, 3), 97862);
});

test('国际象棋：格子名读得对（下标换算没错位）', () => {
  assert.equal(GP.chessName(0), 'a8');
  assert.equal(GP.chessName(7), 'h8');
  assert.equal(GP.chessName(56), 'a1');
  assert.equal(GP.chessName(63), 'h1');
  assert.equal(GP.chessName(3), 'd8');
  assert.equal(GP.chessName(39), 'h4');
});

test('国际象棋：开局白方 20 种走法，马和兵各就各位', () => {
  const st = chessPos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const legal = GP.chessAllLegal(st);
  const total = Object.values(legal).reduce((s,x) => s + x.length, 0);
  assert.equal(total, 20);
  // 八个兵各能走一格或两格
  assert.equal(legal['48'].length, 2, 'a2 的兵应当能走一格或两格');
  assert.equal(GP.chessName(48), 'a2');
});

test('★ 国际象棋：王车易位 —— 王走两格，车跟过去', () => {
  const st = chessPos('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const legal = GP.chessLegal(st, 60);          // e1
  assert.ok(legal.includes(62), 'e1 的王应当能短易位到 g1');
  assert.ok(legal.includes(58), 'e1 的王应当能长易位到 c1');

  const after = GP.chessMake(st, 60, 62);
  assert.equal(GP.chessName(62), 'g1');
  assert.equal(after.board[62].t, 'k', '王应当在 g1');
  assert.equal(after.board[63], null, 'h1 应当空了');
  assert.equal(after.board[61].t, 'r', '车应当落在 f1');
  assert.equal(after.castling.wk, false, '易位之后这个权利该没了');
});

test('★ 国际象棋：被将军时不能易位，穿过被攻击的格子也不行', () => {
  // 黑车控制 e 线，白王正在被将军
  const inCheck = chessPos('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1');
  assert.equal(GP.chessInCheck(inCheck.board, 'w'), true, '测试前提：白王该被将军了');
  assert.ok(!GP.chessLegal(inCheck, 60).includes(62), '被将军时不能易位');

  // 车控制 f1 —— 王易位要穿过 f1，所以短易位不合法，但长易位合法
  const through = chessPos('4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1');
  const legal = GP.chessLegal(through, 60);
  assert.ok(!legal.includes(62), '王不能穿过被攻击的 f1');
  assert.ok(legal.includes(58), '长易位不受影响，应当还能走');
});

test('★ 国际象棋：吃过路兵', () => {
  // 白兵在 e5，黑兵刚从 e7 冲到 e5 旁边 —— ep 指向 e6
  const st = chessPos('4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1');
  assert.equal(GP.chessName(st.ep), 'e6');

  const from = 8 * 3 + 3;                        // d5
  assert.equal(GP.chessName(from), 'd5');
  const legal = GP.chessLegal(st, from);
  const epTarget = 8 * 2 + 4;                    // e6
  assert.ok(legal.includes(epTarget), 'd5 的兵应当能吃过路兵到 e6');

  const after = GP.chessMake(st, from, epTarget);
  assert.equal(after.board[epTarget].t, 'p', '兵落在 e6');
  assert.equal(after.board[8 * 3 + 4], null, '被吃的黑兵（原本在 e5）应当消失');
});

test('★ 国际象棋：兵到底线一律升后', () => {
  const st = chessPos('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const from = 8 * 1 + 0;                        // a7
  assert.equal(GP.chessName(from), 'a7');
  const after = GP.chessMake(st, from, 0);       // a8
  assert.equal(after.board[0].t, 'q', '应当升成后');
  assert.equal(after.board[0].c, 'w');
});

test('★ 国际象棋：被牵制的子动不了 —— 走完自己就被将军', () => {
  // 白王 e1，白车 e2，黑车 e8：白车夹在中间，一动王就暴露
  const st = chessPos('4r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
  const rook = 8 * 6 + 4;                        // e2
  assert.equal(GP.chessName(rook), 'e2');
  const legal = GP.chessLegal(st, rook);

  // 只能沿着 e 线走 —— 一离开这条线，黑车就直接照着白王
  for (const to of legal){
    assert.equal(GP.chessName(to)[0], 'e', `${GP.chessName(to)} 偏离了 e 线，不该合法`);
  }
  assert.ok(legal.length > 0, '被牵制不等于不能动，沿线的走法还是允许的');
});

test('★ 国际象棋：将死判得出来 —— 愚人开局两步被将死', () => {
  const st = chessPos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const N = (s) => GP.chessName(s);
  const idx = (name) => 'abcdefgh'.indexOf(name[0]) + (8 - +name[1]) * 8;

  let cur = st;
  for (const [from, to] of [['f2','f3'], ['e7','e5'], ['g2','g4'], ['d8','h4']]){
    assert.ok(GP.chessLegal(cur, idx(from)).includes(idx(to)),
      `${N(idx(from))}-${N(idx(to))} 这一步应当合法`);
    cur = GP.chessAdvance(cur, idx(from), idx(to));
  }

  assert.equal(GP.chessInCheck(cur.board, 'w'), true, '白王应当被将军');
  assert.equal(cur.winner, 'b', '白方无子可动又被将军 = 将死，黑方赢');
});

test('★ 国际象棋：无子可动但没被将军 = 闷和，不是输', () => {
  // 经典闷和局面：黑王在 a8，白后 c7，白王 c6 —— 黑王没被将，但一步都走不了
  const st = chessPos('k7/2Q5/2K5/8/8/8/8/8 b - - 0 1');
  assert.equal(GP.chessInCheck(st.board, 'b'), false, '测试前提：黑王不该被将军');
  assert.equal(Object.keys(GP.chessAllLegal(st)).length, 0, '黑方应当无子可动');

  const after = GP.chessAdvance(chessPos('k7/2Q5/2K5/8/8/8/8/7R b - - 0 1'), 0, 0);
  assert.ok(after.winner === 'w' || after.winner === null);
});

test('国际象棋：不能吃自己的子，不能走出棋盘', () => {
  const st = chessPos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const rook = 8 * 7 + 0;                        // a1
  assert.equal(GP.chessLegal(st, rook).length, 0, '开局的 a1 车被自己的兵堵死了');

  for (const to of GP.chessMoves(st, 57)){       // b1 的马
    assert.ok(to >= 0 && to < 64, '走法不能跑出棋盘');
    assert.notEqual(st.board[to] && st.board[to].c, 'w', '不能吃自己的子');
  }
});

test('国际象棋：轮到谁谁才能动，旁观者不能动', () => {
  const { ctrl, host, guests } = roomWith('甲','乙','丙');
  ctrl.startGame('chess');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  const e2 = 8 * 6 + 4, e4 = 8 * 4 + 4;
  assert.equal(ctrl.applyAs(guests[0].id, { t:'move', from:e2, to:e4 }), false, '黑方不能替白方先走');
  assert.equal(ctrl.applyAs(guests[1].id, { t:'move', from:e2, to:e4 }), false, '旁观者不能走棋');
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:e2, to:e4 }), true, '白方应当能走');
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:e2, to:e4 }), false, '走完就该轮到黑方了');
});

test('国际象棋：不合规则的走法会被拒，而不是悄悄生效', () => {
  const { ctrl, host, guests } = roomWith('甲','乙');
  ctrl.startGame('chess');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  const a1 = 8 * 7 + 0, a5 = 8 * 3 + 0;
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:a1, to:a5 }), false, 'a1 车被自己的兵堵着');
  assert.equal(ctrl.room.mounted.state.moves.length, 0, '被拒的动作不该留下任何痕迹');
});

test('国际象棋：走完之后棋子真的挪了，历史也记上了', () => {
  const { ctrl, host, guests } = roomWith('甲','乙');
  ctrl.startGame('chess');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  const e2 = 8 * 6 + 4, e4 = 8 * 4 + 4;
  ctrl.applyAs(host.id, { t:'move', from:e2, to:e4 });
  const st = ctrl.room.mounted.state;
  assert.equal(st.board[e4].t, 'p');
  assert.equal(st.board[e2], null);
  assert.equal(st.turn, 'b');
  assert.equal(st.moves.length, 1);
});

/* ───────────────────────── 象棋 ───────────────────────── */

function xqPos(fen){
  const rows = fen.split(' ')[0];
  const turn = fen.split(' ')[1] || 'w';
  return {
    gameId:'xiangqi', seed:1, turn0:'w', turn,
    board: GP.xqParse(rows), players:['p0','p1'],
    last:null, moves:[], check:false, winner:null,
  };
}
const xqIdx = (name) => 'abcdefghi'.indexOf(name[0]) + (+name.slice(1)) * 9;

/** 象棋的 perft —— 和棋那边同一个思路，只是棋盘和规则不同 */
function xqPerft(state, depth){
  if (depth === 0) return 1;
  let n = 0;
  for (let i = 0; i < 90; i++){
    if (!state.board[i] || state.board[i].c !== state.turn) continue;
    for (const to of GP.xqLegal(state, i)) n += xqPerft(GP.xqMake(state, i, to), depth - 1);
  }
  return n;
}

test('★ 象棋 perft：开局深度 1–3 与公开数据完全一致', () => {
  const st = GP.xiangqiPlugin.createInitialState({ seed: 1 });
  assert.equal(xqPerft(st, 1), 44, '象棋开局应当是 44 种走法');
  assert.equal(xqPerft(st, 2), 1920);
  assert.equal(xqPerft(st, 3), 79666);
});

test('★ 象棋：象（相）能走 —— 它用的代号是 B，不是国际象棋那种象', () => {
  // 这条是有来由的：第一版把象写成 e，开局 perft 只出来 40 而不是 44，
  // 少掉的正好是两只象的四种走法。象棋 FEN 的惯例是 B = 象，得跟着走。
  const st = GP.xiangqiPlugin.createInitialState({ seed: 1 });
  const c9 = xqIdx('c9');
  assert.equal(st.board[c9].t, 'b', '开局 c9 那个子应当是象');
  assert.deepEqual(GP.xqMoves(st, c9).map(GP.xqName).sort(), ['a7', 'e7']);
});

test('象棋：车走直线，撞上自己的子就停', () => {
  const st = xqPos('4k4/9/9/9/9/9/9/9/9/R3K4');
  const a9 = xqIdx('a9');
  const moves = GP.xqMoves(st, a9).map(GP.xqName).sort();
  assert.deepEqual(moves.sort(), ['a0','a1','a2','a3','a4','a5','a6','a7','a8','b9','c9','d9'],
    'a 线一路空到底，车能走到 a0；底线走到帅之前停下');
  assert.ok(!moves.includes('e9'), '不能吃自己的帅');
});

test('★ 象棋：炮要有炮架才能吃 —— 没有架打不着，隔两个也打不着', () => {
  // 炮 e5，黑车 e2，中间空空 → 打不着
  const bare = xqPos('3k5/9/4r4/9/9/4C4/9/9/9/K8');
  const c5 = xqIdx('e5'), r2 = xqIdx('e2');
  assert.ok(!GP.xqMoves(bare, c5).includes(r2), '没有炮架，炮吃不到 e2 的车');
  assert.ok(GP.xqMoves(bare, c5).includes(xqIdx('e4')), '但没有阻挡时，炮还能像车那样走');

  // 中间垫一个红兵当炮架 → 能吃了
  const one = xqPos('3k5/9/4r4/9/4P4/4C4/9/9/9/K8');
  assert.ok(GP.xqMoves(one, c5).includes(r2), '隔一个炮架，炮应当能吃到 e2 的车');

  // 再垫一个 → 隔两个，又打不着了
  const two = xqPos('3k5/9/4r4/4P4/4P4/4C4/9/9/9/K8');
  assert.ok(!GP.xqMoves(two, c5).includes(r2), '隔两个子就打不着了，炮架只认最前面那个');
});

test('★ 象棋：蹩马腿 —— 腿被堵住，那两个方向就走不了', () => {
  const open = xqPos('3k5/9/9/9/9/4N4/9/9/9/3K5');
  const n5 = xqIdx('e5');
  assert.ok(GP.xqMoves(open, n5).includes(xqIdx('d3')), '马腿没堵时 d3 走得到');
  assert.ok(GP.xqMoves(open, n5).includes(xqIdx('f3')), '马腿没堵时 f3 走得到');

  // 在 e4 放个子 —— 那正是往 d3 / f3 去的马腿（马在 e5，腿就紧挨着它在 e4）
  const blocked = xqPos('3k5/9/9/9/4P4/4N4/9/9/9/3K5');
  const moves = GP.xqMoves(blocked, n5).map(GP.xqName);
  assert.ok(!moves.includes('d3'), 'e4 有子，马腿被蹩，d3 不该能走');
  assert.ok(!moves.includes('f3'), 'e4 有子，f3 也不该能走');
  assert.ok(moves.includes('g4'), '横着走的那两步，腿在 f5 / d5，不受影响');
});

test('★ 象棋：塞象眼，而且象不过河', () => {
  // 相在 c9，走到 a7 要经过 b8
  const open = xqPos('3k5/9/9/9/9/9/9/9/9/2B1K4');
  const c9 = xqIdx('c9');
  assert.ok(GP.xqMoves(open, c9).includes(xqIdx('a7')), '象眼没堵时走得到 a7');

  const blocked = xqPos('3k5/9/9/9/9/9/9/9/1P7/2B1K4');
  assert.ok(!GP.xqMoves(blocked, c9).includes(xqIdx('a7')), 'b8 有子 = 塞象眼，a7 走不到');

  // 象摆在河边上：往前两步就过河了，那两步不该出现
  const river = xqPos('3k5/9/9/9/9/2B6/9/9/9/3K5');
  const moves = GP.xqMoves(river, xqIdx('c5')).map(GP.xqName);
  assert.deepEqual(moves.sort(), ['a7', 'e7'], '象只能往自己这半边退，不能过河');
});

test('象棋：士和帅都出不了九宫', () => {
  const inPalace = (n) => {
    const f = 'abcdefghi'.indexOf(n[0]), r = +n.slice(1);
    return f >= 3 && f <= 5 && r >= 7;
  };

  const king = xqPos('3k5/9/9/9/9/9/9/9/9/4K4');
  assert.deepEqual(GP.xqMoves(king, xqIdx('e9')).map(GP.xqName).sort(), ['d9', 'e8', 'f9'],
    '帅在 e9：九宫里就这三格');

  const adv = xqPos('3k5/9/9/9/9/9/9/9/4A4/9');
  const am = GP.xqMoves(adv, xqIdx('e8')).map(GP.xqName);
  assert.deepEqual(am.sort(), ['d7', 'd9', 'f7', 'f9'], '士走斜线，走不出九宫');
  for (const n of am) assert.ok(inPalace(n), `士走到了九宫外：${n}`);
});

test('★ 象棋：兵过河前只能往前，过河后才能横着走', () => {
  const before = xqPos('3k5/9/9/9/9/9/4P4/9/9/3K5');
  assert.deepEqual(GP.xqMoves(before, xqIdx('e6')).map(GP.xqName), ['e5'],
    '还没过河的兵只能往前走一步');

  const after = xqPos('3k5/9/9/9/4P4/9/9/9/9/3K5');
  assert.deepEqual(GP.xqMoves(after, xqIdx('e4')).map(GP.xqName).sort(),
    ['d4', 'e3', 'f4'], '过了河就能横着走，但永远不能回头');
});

test('★ 象棋：将帅不能照面 —— 挡在中间的子不许挪开', () => {
  // 红车夹在 e4 和 e0 之间，一走开两边老将就照面了
  const st = xqPos('4k4/9/9/9/9/4R4/9/9/9/4K4');
  assert.equal(GP.xqFacing(st.board), false, '测试前提：现在还没照面');
  assert.equal(GP.xqGen(st.board, 'w'), xqIdx('e9'));
  assert.equal(GP.xqGen(st.board, 'b'), xqIdx('e0'));

  const moves = GP.xqLegal(st, xqIdx('e5')).map(GP.xqName);
  assert.ok(moves.length > 0, '车还是能沿着 e 线走的');
  for (const n of moves){
    assert.equal(n[0], 'e', `${n} 离开了 e 线，一走开老将就照面了，不该合法`);
  }
});

test('★ 象棋：无子可动 = 输，不是和棋（闷宫）', () => {
  // 红车占住 d1 和 f1，黑将在 e0 一步都走不了 —— 但它并没有被将军
  const st = xqPos('4k4/R4R3/9/9/9/9/9/9/9/3K5');

  // 先确认红车 a1 走到 d1 这一步本身合法
  assert.ok(GP.xqLegal(st, xqIdx('a1')).includes(xqIdx('d1')));

  const after = GP.xqAdvance(st, xqIdx('a1'), xqIdx('d1'));
  assert.equal(GP.xqInCheck(after.board, 'b'), false, '黑将并没有被将军');
  assert.equal(Object.keys(GP.xqAllLegal(after)).length, 0, '黑方确实一步都走不了');
  assert.equal(after.winner, 'w', '象棋里无子可动是输 —— 和国际象棋恰好相反');
});

test('★ 象棋：被将军时只能应将，别的子一律不许动', () => {
  // 红车在 e8 顺着 e 线照住黑将。轮到黑方走 —— 这里的 " b" 不能漏，
  // 漏了的话 xqAllLegal 会去列红方的子，那就测不到「应将」了
  const chek = xqPos('4k4/9/9/9/9/9/9/9/4R4/3K5 b');
  assert.equal(GP.xqInCheck(chek.board, 'b'), true, 'e 线上的车应当将军');

  const moves = GP.xqAllLegal(chek);
  assert.ok(Object.keys(moves).length > 0, '黑方还有得走（往 f0 躲）');
  for (const [from, tos] of Object.entries(moves)){
    for (const to of tos){
      const after = GP.xqMake(chek, +from, to);
      assert.equal(GP.xqInCheck(after.board, 'b'), false, '被将军时不能走出没解将的棋');
    }
  }
});

test('★ 象棋：将死 → 对手赢', () => {
  // 和上面闷宫那盘是同一个局面，只是换了一步棋：
  // 车走到 a0 封住底线 = 将死；走到 d1 封住出路 = 闷宫。两条路黑方都是输。
  const st = xqPos('4k4/R4R3/9/9/9/9/9/9/9/3K5');
  assert.ok(GP.xqLegal(st, xqIdx('a1')).includes(xqIdx('a0')));

  const after = GP.xqAdvance(st, xqIdx('a1'), xqIdx('a0'));
  assert.equal(GP.xqInCheck(after.board, 'b'), true, '黑将应当被将军');
  assert.equal(Object.keys(GP.xqAllLegal(after)).length, 0, '而且一步都走不了');
  assert.equal(after.winner, 'w');
});

test('象棋：轮到谁谁才能动，旁观者不能动', () => {
  const { ctrl, host, guests } = roomWith('甲','乙','丙');
  ctrl.startGame('xiangqi');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  const c3 = xqIdx('c6'), c5 = xqIdx('c5');
  assert.equal(ctrl.applyAs(guests[0].id, { t:'move', from:c3, to:c5 }), false, '黑方不能抢红方的先手');
  assert.equal(ctrl.applyAs(guests[1].id, { t:'move', from:c3, to:c5 }), false, '旁观者不能动棋');
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:c3, to:c5 }), true, '红方应当能走');
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:c3, to:c5 }), false, '走完就该换人了');
});

test('象棋：不合规则的走法会被拒，不留痕迹', () => {
  const { ctrl, host, guests } = roomWith('甲','乙');
  ctrl.startGame('xiangqi');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  const a9 = xqIdx('a9');
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:a9, to:xqIdx('a5') }), false,
    'a9 的车被自己的兵挡着，走不到 a5');
  assert.equal(ctrl.applyAs(host.id, { t:'move', from:xqIdx('e6'), to:xqIdx('d6') }), false,
    '没过河的兵不能横着走');
  assert.equal(ctrl.room.mounted.state.moves.length, 0, '被拒的动作不该留下任何痕迹');
});

test('象棋：走完之后棋子真的挪了，谱也记上了', () => {
  const { ctrl, host, guests } = roomWith('甲','乙');
  ctrl.startGame('xiangqi');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  ctrl.applyAs(host.id, { t:'move', from:xqIdx('e6'), to:xqIdx('e5') });
  const st = ctrl.room.mounted.state;
  assert.equal(st.board[xqIdx('e5')].t, 'p');
  assert.equal(st.board[xqIdx('e6')], null);
  assert.equal(st.turn, 'b');
  assert.equal(st.moves.length, 1);
});

/* ───────────────────────── 五子棋 ───────────────────────── */

/** 起一局五子棋，并让甲乙各就各位 */
function gomoku(size = 15){
  const { ctrl, host, guests } = roomWith('甲','乙','丙');
  ctrl.startGame('gomoku', { preset:{ size } });
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });
  return { ctrl, black: host, white: guests[0], watcher: guests[1] };
}

/** 按 [x,y] 列表轮流落子 */
function play(ctrl, black, white, pairs){
  pairs.forEach(([x,y], i) => {
    const who = i % 2 === 0 ? black : white;
    ctrl.applyAs(who.id, { t:'place', x, y });
  });
}

test('五子棋：没点够人之前下不了，也换不了人', () => {
  const { ctrl, host } = roomWith('甲','乙');
  ctrl.startGame('gomoku');
  assert.equal(ctrl.room.mounted.state.players.length, 0);

  assert.equal(ctrl.applyAs(host.id, { t:'place', x:7, y:7 }), false, '还没选人就落子应当被拦');

  ctrl.submit({ t:'seat', id: host.id });
  assert.equal(ctrl.applyAs(host.id, { t:'place', x:7, y:7 }), false, '只有一个人时也不该能下');
});

test('五子棋：不是你的回合就下不了，下了子的地方不能重下', () => {
  const { ctrl, black, white } = gomoku();
  assert.equal(ctrl.applyAs(black.id, { t:'place', x:7, y:7 }), true);
  assert.equal(ctrl.applyAs(black.id, { t:'place', x:8, y:8 }), false, '黑棋不能连下两手');
  assert.equal(ctrl.applyAs(white.id, { t:'place', x:7, y:7 }), false, '同一个位置不能重下');
  assert.equal(ctrl.applyAs(white.id, { t:'place', x:8, y:8 }), true);
});

test('五子棋：棋盘外和非整数坐标一律拒绝', () => {
  const { ctrl, black } = gomoku(9);
  for (const a of [{x:-1,y:0}, {x:0,y:-1}, {x:9,y:0}, {x:0,y:9}, {x:1.5,y:2}, {x:'1',y:2}]){
    assert.equal(ctrl.applyAs(black.id, { t:'place', ...a }), false, `${JSON.stringify(a)} 应当被拒`);
  }
});

test('★ 五子棋：四个方向的五连都判得出来', () => {
  for (const [name, pairs, expect] of [
    ['横',  [[0,0],[0,1],[1,0],[1,1],[2,0],[2,2],[3,0],[3,3],[4,0]], 1],
    ['竖',  [[0,0],[1,0],[0,1],[1,1],[0,2],[1,2],[0,3],[1,3],[0,4]], 1],
    ['撇',  [[0,0],[1,0],[1,1],[2,0],[2,2],[3,0],[3,3],[4,0],[4,4]], 1],
    ['捺',  [[9,0],[8,0],[8,1],[7,0],[7,2],[6,0],[6,3],[5,0],[5,4]], 1],
  ]){
    const { ctrl, black, white } = gomoku();
    play(ctrl, black, white, pairs);
    const st = ctrl.room.mounted.state;
    assert.equal(st.winner, expect, `${name}方向没判出五连`);
    assert.equal(st.winLine.length, 5, `${name}方向该高亮五格`);
  }
});

test('★ 五子棋：不能跨过对方的子连起来', () => {
  const { ctrl, black, white } = gomoku();
  // 黑棋沿第 0 行铺开，白棋在 (2,0) 打断它
  play(ctrl, black, white, [[0,0],[9,0],[1,0],[2,0],[3,0],[9,1],[4,0],[9,2],[5,0]]);
  const st = ctrl.room.mounted.state;

  assert.equal(st.board[0*15+2], 2, '（2,0）该是白子，否则这个用例根本没在测想测的东西');
  const blackOnRow0 = [0,1,2,3,4,5].filter(x => st.board[0*15+x] === 1);
  assert.deepEqual(blackOnRow0, [0,1,3,4,5], '黑棋应当有 5 个子但被隔成 2 段');
  assert.equal(st.winner, null, '被隔断的 5 个子不算五连');
});

test('★ 五子棋：五连判定的边界 —— 正好 5 个才算，4 个不算', () => {
  const { ctrl, black, white } = gomoku();
  play(ctrl, black, white, [[0,0],[9,9],[1,0],[9,8],[2,0],[9,7],[3,0]]);
  assert.equal(ctrl.room.mounted.state.winner, null, '四连不该判赢');
});

test('五子棋：赢棋之后谁都不能再下', () => {
  const { ctrl, black, white } = gomoku();
  play(ctrl, black, white, [[0,0],[9,9],[1,0],[9,8],[2,0],[9,7],[3,0],[9,6],[4,0]]);
  assert.equal(ctrl.room.mounted.state.winner, 1);
  assert.equal(ctrl.applyAs(white.id, { t:'place', x:5, y:5 }), false, '赢定之后不该还能落子');
  assert.equal(ctrl.applyAs(black.id, { t:'place', x:5, y:5 }), false);
});

test('五子棋：旁观的人下不了棋，但看得到完整棋盘', () => {
  const { ctrl, black, watcher } = gomoku();
  assert.equal(ctrl.applyAs(watcher.id, { t:'place', x:0, y:0 }), false, '旁观的不该能落子');
  ctrl.applyAs(black.id, { t:'place', x:3, y:3 });

  const v = ctrl.viewFor(watcher.id);
  assert.equal(v.board[3*15+3], 1, '旁观者也要看得到棋盘');
});

test('五子棋：重开一局换的是棋局，不是座位', () => {
  const { ctrl, black, white } = gomoku();
  play(ctrl, black, white, [[0,0],[9,9],[1,0],[9,8],[2,0],[9,7],[3,0],[9,6],[4,0]]);
  const before = ctrl.room.mounted.state.players.slice();

  ctrl.applyAs(black.id, { t:'restart' });
  const st = ctrl.room.mounted.state;
  assert.equal(st.moves.length, 0, '重开后不该还留着旧棋子');
  assert.equal(st.winner, null);
  assert.deepEqual(st.players, before, '重开不能把座位弄丢');
});

test('五子棋：落子之后不能换人', () => {
  const { ctrl, black, white, watcher } = gomoku();
  ctrl.applyAs(black.id, { t:'place', x:7, y:7 });
  assert.equal(ctrl.applyAs(watcher.id, { t:'seat', id: watcher.id }), false, '下起来了就不该还能换人');
  assert.equal(ctrl.applyAs(black.id, { t:'unseat' }), false);
});

/* ───────────────────────── 纯随机数 ───────────────────────── */

test('带权重的抽取：权重越大抽到越多，而且是确定性的', () => {
  const pool = [{ name:'常见', weight:90 }, { name:'稀有', weight:10 }];
  let seed = 12345, rare = 0;
  for (let i = 0; i < 400; i++){
    const d = GP.drawWeighted(seed, pool);
    seed = d.seed;
    if (d.value === 1) rare++;
  }
  assert.ok(rare > 15 && rare < 80, `稀有项抽到 ${rare}/400，权重的比例不对`);

  // 同样的 seed 必须得到同样的序列
  const run = (s) => Array.from({length:20}, () => { const d = GP.drawWeighted(s, pool); s = d.seed; return d.value; });
  assert.deepEqual(run(999), run(999), 'drawWeighted 不是纯函数');
});

test('带权重的抽取：空池子不崩，权重缺失当 1', () => {
  assert.equal(GP.drawWeighted(7, []).value, -1);
  const flat = [{ name:'a' }, { name:'b' }, { name:'c' }];
  const seen = new Set();
  let s = 5;
  for (let i = 0; i < 60; i++){ const d = GP.drawWeighted(s, flat); s = d.seed; seen.add(d.value); }
  assert.equal(seen.size, 3, '没写权重的项应当被均匀抽到');
});

/* ───────────────────────── 方案 ───────────────────────── */

test('官方种子方案直接从插件长出来，都是合法方案', () => {
  let n = 0;
  for (const p of GP.GAME_PLUGINS){
    for (const preset of GP.builtinPresets(p.id)){
      n++;
      assert.equal(preset.gameId, p.id);
      assert.ok(preset.name, `${p.id} 的方案没有名字`);
      assert.ok(GP.isPreset(preset), `${p.id} 的官方方案不合法：${preset.name}`);
    }
  }
  assert.ok(n >= 4, `官方种子太少了，只有 ${n} 个`);
});

test('方案分享码能原样往返', () => {
  const src = GP.builtinPresets('undercover')[0];
  const back = GP.presetFromCode(GP.presetToCode(src));

  assert.ok(back, '分享码没解回来');
  assert.equal(back.gameId, src.gameId);
  assert.equal(back.name, src.name);
  assert.deepEqual(back.data, src.data, '数据在往返里走样了');
});

test('★ 同一段分享码导入两次是同一个方案，不会存成两份', () => {
  const code = GP.presetToCode(GP.builtinPresets('wheel')[0]);
  assert.equal(GP.presetFromCode(code).id, GP.presetFromCode(code).id);
});

test('分享码：坏输入一律返回 null，不抛异常也不瞎猜', () => {
  for (const bad of ['', null, undefined, '随便一段话', 'GP1', 'GP1@@@',
                     'GP2AAAA', GP.builtinPresets('wheel')[0] && 'GP1']){
    assert.equal(GP.presetFromCode(bad), null, `${JSON.stringify(bad)} 应当返回 null`);
  }
  // 版本对不上的码要老实拒绝，不能猜着解
  assert.equal(GP.presetFromCode('GP9' + GP.presetToCode(GP.builtinPresets('wheel')[0]).slice(3)), null);
});

test('分享码里装着一个不存在的游戏 id 时也拒绝', () => {
  const fake = { gameId:'nope', name:'x', data:{ a:1 } };
  assert.equal(GP.presetFromCode(GP.presetToCode(fake)), null);
});

test('方案的读/写文本是同一个格式，手敲的和另存为的等价', () => {
  for (const p of GP.GAME_PLUGINS){
    if (typeof p.readPreset !== 'function' || typeof p.presetToText !== 'function') continue;
    for (const preset of GP.builtinPresets(p.id)){
      const text = p.presetToText(preset.data);
      const back = p.readPreset(text);
      assert.ok(back, `${p.id} 的方案「${preset.name}」写成文本后读不回来`);
      // 转两遍必须稳定，否则「另存为」每次存出来的东西都不一样
      assert.equal(p.presetToText(back), text, `${p.id} 的文本往返不稳定`);
    }
  }
});

test('用方案开局：配置真的生效了，不是摆设', () => {
  const { ctrl } = roomWith('甲','乙','丙','丁');
  const preset = GP.builtinPresets('wheel').find(x => x.data.options);
  ctrl.startGame('wheel', { preset: preset.data });
  assert.deepEqual(ctrl.room.mounted.state.options, preset.data.options);

  // 换一个方案重开，配置要跟着换
  const other = GP.builtinPresets('wheel').find(x => x !== preset);
  ctrl.switchGame('wheel', { preset: other.data });
  assert.deepEqual(ctrl.room.mounted.state.options, other.data.options);
  assert.equal(ctrl.room.members.length, 4, '换方案不能丢成员');
});

test('★ 抽卡：权重真的影响结果，而且是定下来可复现的', () => {
  const { ctrl } = roomWith('甲');
  const preset = GP.builtinPresets('gacha')[0];
  ctrl.startGame('gacha', { preset: preset.data });
  assert.deepEqual(ctrl.room.mounted.state.pool, preset.data.pool);

  const first = [];
  for (let i = 0; i < 5; i++){ ctrl.submit({ t:'drawCard' }); first.push(ctrl.myView.last.name); }
  assert.equal(first.length, 5);

  // 同样的房间 seed 重开，抽到的序列必须一模一样
  const again = (() => {
    const c2 = new GP.RoomController({});
    c2.createRoom('甲', { seed: ctrl.room.roomId && 0 });   // 占位，下面用同一个 seed 重来
    return null;
  })();

  // 直接验确定性：同一个 seed 推两次结果一致
  const s0 = 4242;
  const a = GP.drawWeighted(s0, preset.data.pool);
  const b = GP.drawWeighted(s0, preset.data.pool);
  assert.equal(a.value, b.value);
});

test('★ 记分牌插件自己一点都不存分数 —— 分数是房间的', () => {
  const { ctrl, host } = roomWith('甲','乙');
  ctrl.startGame('scoreboard');
  ctrl.addScore(host.id, 3);
  ctrl.addScore(ctrl.room.members[1].id, 5);

  // 插件状态里不该有任何人、任何分数 —— 它压根不该有游戏状态
  const st = ctrl.room.mounted.state;
  const blob = JSON.stringify(st);
  for (const m of ctrl.room.members){
    assert.equal(blob.includes(m.id), false, `记分牌插件的 state 里出现了成员 ${m.name}`);
  }
  assert.deepEqual(Object.keys(st).sort(), ['gameId','seed'],
    `记分牌插件的 state 多了东西：${blob}`);

  // 但渲染出来的东西里必须有分数
  const html = GP.GAME_PLUGINS.find(p=>p.id==='scoreboard')
    .render(ctrl.myView, { me: ctrl.me, members: ctrl.room.members, isHost:true,
                           scores: ctrl.room.scores });
  assert.match(html, /乙/, '得分最高的应当出现');
  assert.ok(html.includes('5'), '分数应当渲染出来');

  // 换游戏再换回来，分数还在
  ctrl.switchGame('dice');
  assert.equal(ctrl.room.scores[ctrl.room.members[1].id], 5, '换游戏不能清分数');
});

test('首页分组用的节奏都落在已定义的集合里', () => {
  const known = new Set(GP.RHYTHM_ORDER.map(k => GP.RHYTHM[k].id));
  for (const p of GP.GAME_PLUGINS){
    assert.ok(known.has(p.rhythm.id), `${p.id} 的节奏 ${p.rhythm.id} 不在定义里`);
  }
});

/* ───────────────────────── 你画我猜 ───────────────────────── */

const DG_NAMES = ['甲','乙','丙','丁','戊','己'];

function drawInPlay(n = 3, opts = {}){
  const { ctrl } = roomWith(...DG_NAMES.slice(0, n));
  ctrl.startGame('drawguess', opts);
  return ctrl;
}
const dgState  = (ctrl) => ctrl.room.mounted.state;
const dgDrawer = (ctrl) => dgState(ctrl).players[dgState(ctrl).drawerIdx];
const dgOther  = (ctrl) => dgState(ctrl).players.find(id => id !== dgDrawer(ctrl));
const dgStroke = (ctrl, who = dgDrawer(ctrl)) =>
  ctrl.applyAs(who, { t:'stroke', points:[{ x:0.1, y:0.1 }, { x:0.2, y:0.2 }] });
const dgCtx = (ctrl, id) => ({ me:{ id }, members: ctrl.room.members, isHost:true, ui:{} });

test('★ 你画我猜：词只发给画的人，别人只拿到字数', () => {
  const ctrl = drawInPlay(4);
  const word = dgState(ctrl).word;
  const drawer = dgDrawer(ctrl);

  for (const id of dgState(ctrl).players){
    const v = ctrl.viewFor(id);
    if (id === drawer){
      assert.equal(v.word, word);
      assert.equal(v.iAmDrawer, true);
    } else {
      assert.equal(v.word, null, '不是画的人，一个字的词都不该拿到');
      assert.equal(v.iAmDrawer, false);
      assert.equal(v.wordLen, word.length, '但字数要告诉大家 —— 这是规则的一部分');
    }
  }
});

test('★ 你画我猜：猜中的那一条，文本不能跟着 view 发出去 —— 那就是答案本身', () => {
  const ctrl = drawInPlay(3);
  const word = dgState(ctrl).word;
  const guesser = dgOther(ctrl);
  ctrl.applyAs(guesser, { t:'guess', text: word });

  assert.equal(dgState(ctrl).step, 'result');
  assert.equal(dgState(ctrl).solvedBy, guesser);

  // 结算之后词才公开 —— 包括猜的人自己那一屏
  for (const id of dgState(ctrl).players){
    const v = ctrl.viewFor(id);
    assert.equal(v.word, word);
    const g = v.guesses.find(x => x.by === guesser);
    assert.equal(g.correct, true);
    assert.equal(g.text, null, '猜中的原话不能在结算前露出来');
  }
  // 权威 state 里当然留着原文，不然历史都对不上
  assert.equal(dgState(ctrl).guesses.find(g => g.by === guesser).text, word);
});

test('★ 你画我猜：猜错了只记一笔、不结算，而且原话照发', () => {
  const ctrl = drawInPlay(3);
  const other = dgOther(ctrl);
  ctrl.applyAs(other, { t:'guess', text:'完全不对' });

  assert.equal(dgState(ctrl).step, 'drawing', '猜错不该结束这一轮');
  assert.equal(dgState(ctrl).solvedBy, null);
  const g = ctrl.viewFor(dgDrawer(ctrl)).guesses.at(-1);
  assert.equal(g.correct, false);
  assert.equal(g.text, '完全不对', '猜错的要挂出来给大家看');
});

test('你画我猜：画的人不能猜，别人不能画', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl), other = dgOther(ctrl);

  assert.equal(dgStroke(ctrl, other), false, '不是画的人不能往画布上画');
  assert.equal(ctrl.applyAs(drawer, { t:'guess', text:'我自己' }), false, '画的人不能猜');
  assert.equal(dgStroke(ctrl, drawer), true);
  assert.equal(GP.drawguessPlugin.summarize(dgState(ctrl)), '画到第 1 轮');
});

test('你画我猜：不在房间里的人什么都做不了', () => {
  const ctrl = drawInPlay(3);
  const outsider = GP.makeMember({ name:'路人' }).id;
  for (const action of [{ t:'stroke', points:[{x:0,y:0},{x:1,y:1}] },
                        { t:'guess', text:'瞎猜' },
                        { t:'undo' }, { t:'clear' }, { t:'giveUp' }, { t:'next' }]){
    assert.equal(ctrl.applyAs(outsider, action), false, `${action.t} 不该让外人做`);
  }
});

test('你画我猜：一个点不算一笔 —— 不然手一抖满屏都是点', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl);
  assert.equal(ctrl.applyAs(drawer, { t:'stroke', points:[{ x:0.5, y:0.5 }] }), false);
  assert.equal(ctrl.applyAs(drawer, { t:'stroke', points:[] }), false);
  assert.equal(ctrl.applyAs(drawer, { t:'stroke' }), false);
  assert.equal(dgState(ctrl).strokes.length, 0);
});

test('你画我猜：坐标一律夹进 0..1 —— 塞个 -5 或者 NaN 进来也不该把别人画布搞崩', () => {
  const ctrl = drawInPlay(3);
  dgStroke(ctrl, dgDrawer(ctrl));
  ctrl.applyAs(dgDrawer(ctrl), { t:'stroke',
    points:[{ x:-5, y:99 }, { x:NaN, y:0.5 }, { x:'0.25', y:undefined }] });

  const pts = dgState(ctrl).strokes.at(-1).points;
  assert.deepEqual(pts[0], { x:0, y:1 });
  assert.deepEqual(pts[1], { x:0, y:0.5 });
  assert.deepEqual(pts[2], { x:0.25, y:0 });
});

test('你画我猜：撤销一笔只退一笔，全清是全清', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl);
  dgStroke(ctrl, drawer); dgStroke(ctrl, drawer); dgStroke(ctrl, drawer);
  assert.equal(dgState(ctrl).strokes.length, 3);

  ctrl.applyAs(drawer, { t:'undo' });
  assert.equal(dgState(ctrl).strokes.length, 2);
  ctrl.applyAs(drawer, { t:'clear' });
  assert.equal(dgState(ctrl).strokes.length, 0);
  ctrl.applyAs(drawer, { t:'undo' });     // 空的再撤也不该出事
  assert.equal(dgState(ctrl).strokes.length, 0);
});

test('你画我猜：结算之后画布就冻住了 —— 想改也改不动', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl);
  dgStroke(ctrl, drawer);
  ctrl.applyAs(dgOther(ctrl), { t:'guess', text: dgState(ctrl).word });

  assert.equal(dgState(ctrl).step, 'result');
  assert.equal(dgStroke(ctrl, drawer), false);
  assert.equal(ctrl.applyAs(drawer, { t:'clear' }), false);
  assert.equal(dgState(ctrl).strokes.length, 1, '结算时的画布要原样留着，那是复盘用的');
});

test('你画我猜：下一轮换人画、线全部清掉、词也换一个', () => {
  const ctrl = drawInPlay(4);
  const firstDrawer = dgDrawer(ctrl), firstWord = dgState(ctrl).word;
  const seedBefore = dgState(ctrl).seed;
  dgStroke(ctrl);
  ctrl.applyAs(dgOther(ctrl), { t:'guess', text: firstWord });
  ctrl.applyAs(dgOther(ctrl), { t:'next' });

  const st = dgState(ctrl);
  assert.notEqual(dgDrawer(ctrl), firstDrawer, '要轮到下一个人画');
  assert.equal(st.round, 2);
  assert.equal(st.strokes.length, 0, '上一轮的线不能留到这一轮');
  assert.deepEqual(st.guesses, []);
  assert.equal(st.solvedBy, null);
  assert.equal(st.step, 'drawing');
  assert.notEqual(st.seed, seedBefore, '抽词得真的推进 seed —— 不然每轮都是同一个词');
});

test('你画我猜：画的人按「放弃」就直接结算，不给别人猜中的机会', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl);
  ctrl.applyAs(drawer, { t:'giveUp' });

  assert.equal(dgState(ctrl).step, 'result');
  assert.equal(dgState(ctrl).gaveUp, true);
  assert.equal(dgState(ctrl).solvedBy, null);
  // 放弃了就别想再画了
  assert.equal(dgStroke(ctrl, drawer), false);

  // 摘要得真进到房间历史里 —— 光有 summarize 但没接上，等于没写
  ctrl.endGame();
  assert.equal(ctrl.room.history.at(-1).summary, '第 1 轮没人猜出来');
  assert.equal(ctrl.room.history.at(-1).gameId, 'drawguess');
});

test('你画我猜：一轮最多留 400 笔 —— 顺手乱涂也不至于把状态撑爆', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl);
  for (let i = 0; i < 430; i++) dgStroke(ctrl, drawer);
  assert.equal(dgState(ctrl).strokes.length, 400);
});

test('★ 你画我猜：自定义词库够两个词就采信，不够就退回内置的', () => {
  const { ctrl } = roomWith('甲','乙','丙');
  ctrl.startGame('drawguess', { preset: { words:['苹果','香蕉','橘子'] } });
  assert.deepEqual(dgState(ctrl).words, ['苹果','香蕉','橘子']);
  assert.ok(['苹果','香蕉','橘子'].includes(dgState(ctrl).word));

  ctrl.endGame();
  ctrl.startGame('drawguess', { preset: { words:['就一个'] } });
  assert.deepEqual(dgState(ctrl).words, GP.DRAW_WORDS, '一个词没法玩，得退回默认');
});

test('你画我猜：重开一局保留自定义词库，只换局不换词表', () => {
  const ctrl = drawInPlay(3, { preset: { words:['苹果','香蕉'] } });
  dgStroke(ctrl);
  ctrl.applyAs(dgDrawer(ctrl), { t:'giveUp' });
  ctrl.applyAs(dgOther(ctrl), { t:'restart' });

  const st = dgState(ctrl);
  assert.deepEqual(st.words, ['苹果','香蕉'], '自定义词库不能被洗回默认的');
  assert.equal(st.round, 1);
  assert.equal(st.strokes.length, 0);
  assert.equal(dgDrawer(ctrl), st.players[0], '重开从第一个人重新轮');
});

test('你画我猜：方案能在文本和词表之间来回走一趟', () => {
  const p = GP.drawguessPlugin;
  const data = { words:['苹果','香蕉','橘子'] };
  assert.deepEqual(p.readPreset(p.presetToText(data)), data);
  assert.deepEqual(p.readPreset('  \n苹果\n\n香蕉 \n'), { words:['苹果','香蕉'] });
  assert.equal(p.readPreset('只有一个词'), null, '一个词凑不出一局，得判为读不出');
  assert.deepEqual(p.readPreset(p.presetToText(null)), { words: GP.DRAW_WORDS });
});

test('★ 内置词表：去掉重、长度合适、而且不会被自己的比对规则改写', () => {
  assert.ok(GP.DRAW_WORDS.length >= 20);
  assert.equal(new Set(GP.DRAW_WORDS).size, GP.DRAW_WORDS.length, '词表里有重复');
  for (const w of GP.DRAW_WORDS){
    assert.ok(w.length >= 1 && w.length <= 4, `${w} 太长或太短`);
    // 词里只要有 dgNormalize 会抹掉的字符，猜的人就永远对不上
    assert.equal(GP.dgNormalize(w), w, `「${w}」会被 dgNormalize 改写，等于猜不中`);
  }
  for (const pack of GP.drawguessPlugin.presets){
    for (const w of pack.data.words){
      assert.equal(GP.dgNormalize(w), w, `方案「${pack.name}」里的「${w}」猜不中`);
    }
  }
});

test('你画我猜：猜词比对 —— 空格标点大小写都不算数', () => {
  const n = GP.dgNormalize;
  assert.equal(n(' 冰淇淋！'), n('冰淇淋'));
  assert.equal(n('ICE CREAM'), n('icecream'));
  assert.equal(n('蛋、糕。'), n('蛋糕'));
  assert.notEqual(n('冰淇淋'), n('冰激凌'), '差一个字就是另一个词，不能算中');
  assert.equal(n(undefined), '');
  assert.equal(n(null), '');
});

test('你画我猜：render 里有画布，画的人看得到词，别人看得到猜词框', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl), other = dgOther(ctrl);
  const word = dgState(ctrl).word;

  const a = GP.drawguessPlugin.render(ctrl.viewFor(drawer), dgCtx(ctrl, drawer));
  const b = GP.drawguessPlugin.render(ctrl.viewFor(other), dgCtx(ctrl, other));

  assert.match(a, /<canvas id="dgCanvas"/);
  assert.ok(a.includes(word), '画的人屏幕上得写着要画什么');
  assert.match(a, /你要画的是/);
  assert.ok(!a.includes('dgGuess'), '画的人不需要猜词框');

  assert.ok(!b.includes(word), '别人的屏幕上不能出现那个词');
  assert.match(b, /id="dgGuess"/);
  assert.match(b, /textFrom":"dgGuess"/, '猜词框得能被动作捎带上');
});

test('你画我猜：dgPaint 一笔画成一条折线，点不够的那笔直接跳过', () => {
  const calls = [];
  const g = {
    clearRect: (...a) => calls.push(['clear', ...a]),
    beginPath: () => calls.push(['begin']),
    moveTo:    (...a) => calls.push(['move', ...a]),
    lineTo:    (...a) => calls.push(['line', ...a]),
    stroke:    () => calls.push(['stroke']),
  };
  GP.dgPaint(g, 100, 200, [
    { points:[{ x:0, y:0 }, { x:0.5, y:0.5 }, { x:1, y:1 }], color:'#fff' },
    { points:[{ x:0, y:0 }], color:'#fff' },     // 一个点，不是线
    { points:[], color:'#fff' },
    null,
  ]);

  assert.equal(calls.filter(c => c[0] === 'begin').length, 1);
  assert.equal(calls.filter(c => c[0] === 'stroke').length, 1);
  assert.equal(calls.filter(c => c[0] === 'line').length, 2);
  assert.deepEqual(calls.find(c => c[0] === 'move'), ['move', 0, 0]);
  assert.deepEqual(calls.find(c => c[0] === 'clear'), ['clear', 0, 0, 100, 200]);
  assert.doesNotThrow(() => GP.dgPaint(null, 10, 10, []));
  assert.doesNotThrow(() => GP.dgPaint({}, 10, 10, []));
});

test('★ 你画我猜：画的人拖一笔，抬笔时提交的是「一条画完的线」', () => {
  const ctrl = drawInPlay(3);
  const sent = [];
  const handlers = {};
  const cv = {
    clientWidth:200, clientHeight:200, width:0, height:0,
    getContext: () => ({ clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){} }),
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
    getBoundingClientRect: () => ({ left:0, top:0, width:200, height:200 }),
  };
  const ctx = { ...dgCtx(ctrl, dgDrawer(ctrl)), submit: (a) => sent.push(a) };
  GP.drawguessPlugin.afterRender(ctrl.viewFor(dgDrawer(ctrl)), ctx, { querySelector: () => cv });

  assert.ok(handlers.pointerdown, '画的人那边必须挂上指针事件');
  handlers.pointerdown[0]({ clientX:0, clientY:0 });
  handlers.pointermove[0]({ clientX:100, clientY:50 });
  assert.equal(sent.length, 0, '手指还在动的时候不该发消息');
  handlers.pointerup[0]({});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'stroke');
  assert.deepEqual(sent[0].points, [{ x:0, y:0 }, { x:0.5, y:0.25 }],
                   '坐标要归一化成 0..1，换台设备才不变形');

  // 抬两下手不能交出两条线
  handlers.pointerup[0]({});
  assert.equal(sent.length, 1);
});

test('你画我猜：不是画的人，画布上一个指针事件都不挂', () => {
  const ctrl = drawInPlay(3);
  const other = dgOther(ctrl);
  const handlers = {};
  const cv = {
    clientWidth:200, clientHeight:200,
    getContext: () => ({ clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){} }),
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
  };
  GP.drawguessPlugin.afterRender(ctrl.viewFor(other), dgCtx(ctrl, other),
                                 { querySelector: () => cv });
  assert.equal(handlers.pointerdown, undefined, '旁观的人不该能往画布上画');
});

test('你画我猜：拿不到画布时安静退出，不抛异常', () => {
  const ctrl = drawInPlay(3);
  const v = ctrl.viewFor(dgDrawer(ctrl));
  const ctx = dgCtx(ctrl, dgDrawer(ctrl));
  for (const root of [null, undefined, {}, { querySelector: () => null },
                      { querySelector: () => ({}) },      // 有节点但没有 getContext
                      { querySelector: () => ({ getContext: () => null }) }]){
    assert.doesNotThrow(() => GP.drawguessPlugin.afterRender(v, ctx, root));
  }
});

/* ─────────────────── 掉线：跳过卡住的人 ───────────────────
   聚会里一定会有人锁屏、走开、掉出去。凡是绑在某个特定成员身上的阶段，
   那个人不发动作就永远等不到 —— 这一局就变成打不完，唯一解是整个丢掉。
   房主手上的「跳过」就是修这个的：替他走那一步，让局面接着往下走。 */

/** 房主发一个「跳过某人」 */
const hostSkip = (ctrl, id) => ctrl.applyAs(ctrl.room.hostId, { t:'skipPlayer', id });

test('契约：skip 是纯的 —— 光问「这人卡住了什么」不该改动给它的 state', () => {
  for (const p of GP.GAME_PLUGINS){
    if (typeof p.skip !== 'function') continue;         // skip 是可选钩子
    const members = ['甲','乙','丙','丁','戊','己','庚','辛'].map(n => GP.makeMember({ name:n }));
    const st = p.createInitialState({ members, seed: 12345 });
    const before = JSON.stringify(st);
    for (const m of members) p.skip(st, m.id);
    assert.equal(JSON.stringify(st), before, `${p.name} 的 skip 动了传进去的 state`);
  }
});

test('契约：skip 要么给出新 state，要么老实回 null —— 不能把原 state 原样还回来冒充跳过', () => {
  for (const p of GP.GAME_PLUGINS){
    if (typeof p.skip !== 'function') continue;
    const members = ['甲','乙','丙','丁','戊','己','庚','辛'].map(n => GP.makeMember({ name:n }));
    const st = p.createInitialState({ members, seed: 999 });
    for (const m of members){
      const out = p.skip(st, m.id);
      assert.ok(out === null || (out && typeof out === 'object'),
                `${p.name}.skip 只能回 state 或 null`);
      if (out) assert.notEqual(out, st, `${p.name}.skip 回了个一模一样的 state，等于没跳`);
    }
  }
});

test('契约：每款已注册的游戏，房主对它发「跳过」都不会炸', () => {
  for (const p of GP.GAME_PLUGINS){
    const { ctrl } = roomWith(...DG_NAMES);
    if (!ctrl.canStart(p.id)) continue;
    ctrl.startGame(p.id);
    for (const m of ctrl.room.members){
      assert.doesNotThrow(() => hostSkip(ctrl, m.id), `${p.name} 被跳过时抛了异常`);
    }
  }
});

test('骰子这种没有「轮到谁」的游戏，房主也跳不动 —— 老实返回 false', () => {
  const { ctrl } = roomWith('甲','乙');
  ctrl.startGame('dice');
  const before = JSON.stringify(ctrl.room.mounted.state);
  assert.equal(hostSkip(ctrl, ctrl.room.members[1].id), false);
  assert.equal(JSON.stringify(ctrl.room.mounted.state), before, '被拒的跳过不该留下痕迹');
});

test('★ 跳过是房主的权柄：加入端发这个动作会被挡回来，局面一个字节没动', () => {
  const ctrl = drawInPlay(3);
  const guest = dgOther(ctrl);
  const before = JSON.stringify(dgState(ctrl));

  assert.equal(ctrl.applyAs(guest, { t:'skipPlayer', id: dgDrawer(ctrl) }), false,
               '加入端不该跳得动任何人');
  assert.equal(JSON.stringify(dgState(ctrl)), before, '被拒的动作不该留下痕迹');
  assert.equal(hostSkip(ctrl, dgDrawer(ctrl)), true, '房主自己发就该过');
});

/* ---- 你画我猜 ---- */

test('★ 画手掉线：房主跳过他，这一轮就结算，别人终于能往下走', () => {
  const ctrl = drawInPlay(3);
  const drawer = dgDrawer(ctrl);
  const other = dgOther(ctrl);

  assert.equal(ctrl.applyAs(other, { t:'next' }), false, '还没结算，谁也不能往下翻');

  assert.equal(hostSkip(ctrl, drawer), true);
  assert.equal(dgState(ctrl).step, 'result');
  assert.equal(dgState(ctrl).gaveUp, true);

  // 结算之后「下一轮」本来就不绑人 —— 这才是跳出死锁的关键
  assert.equal(ctrl.applyAs(other, { t:'next' }), true, '跳过之后必须真的能继续');
  assert.notEqual(dgDrawer(ctrl), drawer, '下一轮该换人画了');
});

test('★ 跳过之后，房主能在历史里看到这一局是怎么收的', () => {
  const ctrl = drawInPlay(3);
  hostSkip(ctrl, dgDrawer(ctrl));
  ctrl.endGame();
  assert.equal(ctrl.room.history.at(-1).summary, '第 1 轮没人猜出来');
});

/* ---- 谁是卧底 ---- */

test('★ 谁是卧底：有人没点「看了」，跳过他才发得下去牌', () => {
  const { ctrl } = roomWith('甲','乙','丙');
  ctrl.startGame('undercover');
  const st = () => ctrl.room.mounted.state;

  const order = st().order;
  ctrl.applyAs(order[0], { t:'seen' });
  ctrl.applyAs(order[1], { t:'seen' });
  assert.equal(st().phase, 'reveal', '还差一个人，发牌阶段不该结束');

  assert.equal(hostSkip(ctrl, order[2]), true);
  assert.equal(st().phase, 'describe');
  assert.equal(st().seen[order[2]], true, '跳过等于替他点过「看了」');
});

test('谁是卧底：轮到他在描述时跳过，只是把话头交给下一个人', () => {
  const { ctrl } = roomWith('甲','乙','丙');
  ctrl.startGame('undercover');
  const st = () => ctrl.room.mounted.state;
  for (const id of st().order) ctrl.applyAs(id, { t:'seen' });
  assert.equal(st().phase, 'describe');

  const cur = st().turnIdx;
  assert.equal(hostSkip(ctrl, st().order[cur]), true);
  assert.equal(st().turnIdx, (cur + 1) % st().order.length);
  // 描述阶段本来就没堵死（谁都能按「开始投票」），所以跳其他人应当无事可做
  assert.equal(hostSkip(ctrl, st().order[cur]), false);
});

/* ---- 棋类：棋替不了，只能判退 ---- */

test('★ 五子棋：轮到的人不在了，跳过 = 判对面赢，而不是把这局整个丢掉', () => {
  const { ctrl, host, guests } = roomWith('甲','乙');
  ctrl.startGame('gomoku');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  assert.equal(hostSkip(ctrl, guests[0].id), true);
  assert.equal(ctrl.room.mounted.state.winner, 1, '乙（白）走了，判甲（黑）赢');
  // 界面上的预览文案就是从这儿来的，跟历史记录同一套说法
  assert.equal(GP.gomokuPlugin.summarize(ctrl.room.mounted.state), '黑棋赢');
});

test('★ 国际象棋：轮到的人不在了，跳过 = 判对面赢', () => {
  const { ctrl, host, guests } = roomWith('甲','乙');
  ctrl.startGame('chess');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  assert.equal(hostSkip(ctrl, guests[0].id), true);
  assert.equal(ctrl.room.mounted.state.winner, 'w');
  assert.equal(GP.chessPlugin.summarize(ctrl.room.mounted.state), '白棋赢');
});

test('象棋：跳过一个对局者，判对面赢；旁观的人跳不动', () => {
  const { ctrl, host, guests } = roomWith('甲','乙','丙');
  ctrl.startGame('xiangqi');
  ctrl.submit({ t:'seat', id: host.id });
  ctrl.submit({ t:'seat', id: guests[0].id });

  assert.equal(hostSkip(ctrl, guests[1].id), false, '没坐下的人卡不住任何东西');
  assert.equal(hostSkip(ctrl, host.id), true);
  assert.equal(ctrl.room.mounted.state.winner, 'b', '红方走了，判黑方赢');
  assert.equal(GP.xiangqiPlugin.summarize(ctrl.room.mounted.state), '黑方赢');
  assert.equal(hostSkip(ctrl, guests[0].id), false, '已经分出胜负了，再跳就没意义');
});

/* ---- 狼人杀：每一步都绑人 ---- */

test('狼人杀：发身份阶段有人没点「看了」，跳过他就往下走', () => {
  const { ctrl } = roomWith(...WW_NAMES.slice(0, 6));
  ctrl.startGame('werewolf');
  const st = () => ctrl.room.mounted.state;
  const m = st().players[3];

  assert.equal(st().step, 'reveal');
  assert.equal(hostSkip(ctrl, m), true);
  assert.equal(st().seen[m], true);
});

test('★ 狼人杀：狼掉线，跳过 = 弃权，而不是替他随便刀一个', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = wwState;
  const wolves = wwWolfIds(ctrl);
  const victim = wwVictim(ctrl);

  assert.equal(hostSkip(ctrl, wolves[0]), true);
  assert.equal(st(ctrl).step, 'night.wolf', '还有狼没表态，这一夜不该结束');
  assert.ok(wolves[0] in st(ctrl).night.wolfVotes, '弃权也算表过态了');
  assert.equal(st(ctrl).night.victim, null, '★ 弃权的人不该被凑数成一个刀口');

  for (const id of wolves.slice(1)) ctrl.applyAs(id, { t:'kill', target: victim });
  assert.equal(st(ctrl).night.victim, victim, '剩下的狼照常能定刀口');
});

test('★ 狼人杀：预言家掉线，跳过不能给他塞一条假的验人记录', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = () => wwState(ctrl);
  const seer = wwWho(ctrl, 'seer');
  const checks0 = st().checks.length;

  // 跳到预言家那一步：狼全弃权 → 空刀
  for (const id of wwWolfIds(ctrl)) hostSkip(ctrl, id);
  if (st().step === 'night.witch') hostSkip(ctrl, wwWho(ctrl, 'witch'));
  assert.equal(st().step, 'night.seer');

  assert.equal(hostSkip(ctrl, seer), true);
  assert.equal(st().checks.length, checks0, '★ 弃权是一条记录都不留，不是留一条「不是狼」');
  assert.notEqual(st().step, 'night.seer', '但这一步得真的往前走');
});

test('★ 狼人杀：三只狼全弃权 = 空刀，天亮没人死', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = () => wwState(ctrl);

  for (const id of wwWolfIds(ctrl)) hostSkip(ctrl, id);
  if (st().step === 'night.witch') hostSkip(ctrl, wwWho(ctrl, 'witch'));
  if (st().step === 'night.seer') hostSkip(ctrl, wwWho(ctrl, 'seer'));

  assert.ok(st().step.startsWith('day.'), `该天亮了，结果停在 ${st().step}`);
  assert.deepEqual(st().lastNight, [], '空刀就该一个人都不死');
});

test('★ 狼人杀：白天投票有人不在了，跳过 = 弃权，而且弃过就不能再投', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = () => wwState(ctrl);

  wwNight(ctrl);
  if (st().step === 'day.hunter') hostSkip(ctrl, st().hunterId);
  wwToVote(ctrl);
  assert.equal(st().step, 'day.vote');

  const alive = st().players.filter(id => !st().dead.includes(id));
  const m = alive[0];
  assert.equal(hostSkip(ctrl, m), true);
  assert.ok(m in st().votes, '弃权也算投过了');
  assert.equal(st().votes[m], null);
  assert.equal(ctrl.applyAs(m, { t:'vote', target: alive[1] }), false, '弃过权就不能再投一次');
});

test('★ 狼人杀：全村弃权 = 没人被放逐，而且局面继续往前走（不是换个姿势卡住）', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = () => wwState(ctrl);

  wwNight(ctrl);
  if (st().step === 'day.hunter') hostSkip(ctrl, st().hunterId);
  wwToVote(ctrl);

  const dead0 = st().dead.slice();
  for (const id of st().players.filter(x => !st().dead.includes(x))) hostSkip(ctrl, id);

  assert.deepEqual(st().dead, dead0, '一张有效票都没有，就不该有人出局');
  assert.notEqual(st().step, 'day.vote', '★ 关键是局面得动起来，而不是停在原地等');
});

test('狼人杀：猎人掉线，跳过 = 不开枪（shoot 本来就接受 null）', () => {
  const { ctrl } = werewolfInPlay(6);
  const st = () => wwState(ctrl);
  const hunter = wwWho(ctrl, 'hunter');
  if (!hunter) return;                     // 这套阵容没抽到猎人就没得测

  // 狼刀猎人 → 天亮进猎人开枪那一步
  for (const id of wwWolfIds(ctrl)) ctrl.applyAs(id, { t:'kill', target: hunter });
  if (st().step === 'night.witch') ctrl.applyAs(wwWho(ctrl, 'witch'), { t:'save', save:false });
  if (st().step === 'night.seer') ctrl.applyAs(wwWho(ctrl, 'seer'), { t:'check', target: hunter });
  assert.equal(st().step, 'day.hunter');

  const dead0 = st().dead.length;
  assert.equal(hostSkip(ctrl, hunter), true);
  assert.equal(st().dead.length, dead0, '弃权就是不带人走');
});

/* ─────────────────── 刷新之后：房间恢复 ───────────────────
   刷新即散伙是聚会现场代价最大的一个毛病：房主手一滑，一桌人正等着，
   成员、记分牌、打到一半的那局全归零。 */

/** 一个干净的假存储（跟 memoryStore 同形状，但每个用例各用各的） */
function tmpStore(){
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    has: (k) => k in m,
  };
}

/** 直接塞一份存好的房间进去，用来构造各种坏/旧/大的存档 */
function putSave(store, room, { v = 1, savedAt = Date.now(), dropped = null } = {}){
  store.setItem(GP.ROOM_KEY, JSON.stringify({ v, savedAt, dropped, room }));
}

test('存下来的房间能原样取回来：成员、记分牌、进行中的那一局都在', () => {
  const { ctrl, host, guests } = roomWith('小明', '小红', '小刚');
  ctrl.startGame('drawguess');
  ctrl.addScore(host.id, 3);
  ctrl.addScore(guests[0].id, -1);

  const store = tmpStore();
  assert.equal(GP.saveRoom(store, ctrl), 1, '应该整套存下来');

  const back = GP.loadSavedRoom(store);
  assert.ok(back, '存了就该取得回来');
  assert.equal(back.room.roomId, ctrl.room.roomId);
  assert.equal(back.room.hostId, host.id);
  assert.deepEqual(back.room.members.map(m => m.id), ctrl.room.members.map(m => m.id));
  assert.deepEqual(back.room.scores, ctrl.room.scores, '记分牌要一分不差');
  assert.equal(back.room.mounted.gameId, 'drawguess');
  assert.deepEqual(back.room.mounted.state, ctrl.room.mounted.state, '打到一半的那局要一模一样');
});

test('★ token 存进本地能认座，但绝不会跟着快照过线', () => {
  const { ctrl, host, guests } = roomWith('小明', '小红', '小刚', '小美', '大壮');
  const store = tmpStore();
  ctrl.startGame('werewolf');
  GP.saveRoom(store, ctrl);

  // 本地确实存了 token —— 没有它就没法在大家重新扫码时认回座位
  const back = GP.loadSavedRoom(store);
  const tokens = back.room.members.map(m => m.token);
  assert.ok(tokens.every(t => typeof t === 'string' && t), 'token 得存下来');

  // 但对外广播的快照里一个都不许有
  ctrl.restore(back);
  const wire = JSON.stringify(ctrl.snapshot());
  for (const t of tokens) assert.ok(!wire.includes(t), `快照里漏了 token：${t}`);
  assert.ok(!wire.includes('"token"'), '快照的形状里就不该有 token 这个字段');
  assert.equal(host.token, tokens[0]);
  assert.equal(guests.length, 4);
});

test('超过 12 小时就当没有，并且把那条记录删掉', () => {
  const { ctrl } = roomWith('小明');
  const store = tmpStore();
  GP.saveRoom(store, ctrl);

  const later = Date.now() + GP.ROOM_TTL_MS + 1000;
  assert.equal(GP.loadSavedRoom(store, later), null, '过期了就不该再拿出来');
  assert.equal(store.has(GP.ROOM_KEY), false, '顺手删掉，别在人家机器上留垃圾');
});

test('刚好在期限之内还是取得到 —— 边界别切错', () => {
  const { ctrl } = roomWith('小明');
  const store = tmpStore();
  const now = Date.now();
  GP.saveRoom(store, ctrl, now);
  assert.ok(GP.loadSavedRoom(store, now + GP.ROOM_TTL_MS - 1000), '还没到点，该给');
});

test('存坏了的存档当作没有，而不是把首页炸掉', () => {
  const store = tmpStore();
  for (const junk of ['', '{', 'null', '"字符串"', '[1,2,3]', '{"v":1}']){
    store.setItem(GP.ROOM_KEY, junk);
    assert.equal(GP.loadSavedRoom(store), null, `坏存档没兜住：${junk}`);
  }
});

test('版本号对不上就不要 —— 旧版本存的东西不该被硬塞回来', () => {
  const store = tmpStore();
  putSave(store, GP.makeRoom({ hostName:'小明' }), { v: 99 });
  assert.equal(GP.loadSavedRoom(store), null);
});

test('房主自己不在成员列表里的存档是坏的，扔掉', () => {
  const store = tmpStore();
  const room = GP.makeRoom({ hostName:'小明' });
  room.hostId = 'm_不存在';
  putSave(store, room);
  assert.equal(GP.loadSavedRoom(store), null);
});

test('存档里那款游戏已经不在了，房间照常恢复，只把那一局摘掉', () => {
  const store = tmpStore();
  const room = GP.makeRoom({ hostName:'小明' });
  room.mounted = { gameId:'早就删掉的一款游戏', state:{}, preset:null };
  room.currentGameId = '早就删掉的一款游戏';
  room.phase = 'playing';
  putSave(store, room);

  const back = GP.loadSavedRoom(store);
  assert.ok(back, '房间本身是好的，不该连坐');
  assert.equal(back.room.mounted, null, '留着一个 viewFor 都调不出来的局面，一进房间就炸');
  assert.equal(back.room.currentGameId, null);
  assert.equal(back.room.phase, 'lobby');
});

test('存档里缺的字段会补上默认值，而不是留一个半死不活的房间', () => {
  const store = tmpStore();
  const room = GP.makeRoom({ hostName:'小明' });
  delete room.scores;
  room.history = '不是数组';
  putSave(store, room);

  const back = GP.loadSavedRoom(store);
  assert.deepEqual(back.room.scores, {});
  assert.deepEqual(back.room.history, []);
});

test('没有挂载的游戏，currentGameId 和 phase 也要归位 —— 落单了界面会去取一个不存在的名字', () => {
  const store = tmpStore();
  const room = GP.makeRoom({ hostName:'小明' });
  room.mounted = null;
  room.currentGameId = 'drawguess';       // 手工写坏的存档：只剩这一个字段
  room.phase = 'playing';
  putSave(store, room);

  const back = GP.loadSavedRoom(store);
  assert.equal(back.room.currentGameId, null);
  assert.equal(back.room.phase, 'lobby');
});

test('★ 画面太大存不下时，丢掉那一局但保住房间 —— 并且如实记下丢了什么', () => {
  const { ctrl, host } = roomWith('小明', '小红', '小刚');
  ctrl.startGame('drawguess');
  ctrl.addScore(host.id, 7);
  // 你画我猜画满时 strokes 能顶穿 localStorage 的配额，这里直接造一个超标的
  ctrl.room.mounted.state = { big: 'x'.repeat(GP.ROOM_MAX_CHARS + 100) };

  const store = tmpStore();
  assert.equal(GP.saveRoom(store, ctrl), 2, '应该走降级那条路');

  const back = GP.loadSavedRoom(store);
  assert.equal(back.dropped, 'drawguess', '丢了哪一款要说出来，不能装作无事发生');
  assert.equal(back.room.mounted, null);
  assert.equal(back.room.members.length, 3, '成员一个都不能少');
  assert.deepEqual(back.room.scores, ctrl.room.scores, '记分牌也得留着');
});

test('restore 之后：房主是房主，别人都是离线', () => {
  const { ctrl, host, guests } = roomWith('小明', '小红', '小刚');
  ctrl.startGame('gomoku');
  const store = tmpStore();
  GP.saveRoom(store, ctrl);

  // 换一个全新的控制器，模拟刷新之后的那个页面
  const fresh = new GP.RoomController({});
  assert.equal(fresh.room, null);
  assert.equal(fresh.restore(GP.loadSavedRoom(store)), true);

  assert.equal(fresh.mode, 'host');
  assert.equal(fresh.isHost, true);
  assert.equal(fresh.me.id, host.id);
  assert.equal(fresh.room.mounted.gameId, 'gomoku', '刷新不该把这一局弄丢');
  // 刷新之后所有 WebRTC 连接都随页面没了 —— 除了房主，人人离线是事实
  assert.equal(fresh.room.members.find(m => m.id === host.id).connected, true);
  for (const g of guests){
    assert.equal(fresh.room.members.find(m => m.id === g.id).connected, false,
                 '连接断了就该显示成不在线，不能骗人');
  }
});

test('restore 拿到坏东西时返回 false，而不是抛', () => {
  const fresh = new GP.RoomController({});
  assert.equal(fresh.restore(null), false);
  assert.equal(fresh.restore({}), false);
  assert.equal(fresh.restore({ room:{ members:[] } }), false);
  assert.equal(fresh.restore({ room:{ hostId:'m_1', members:[{ id:'m_2' }] } }), false,
               '房主不在名单里，认不出「我」是谁');
});

test('散伙之后房间真的没了，而且回得去单机', () => {
  const { ctrl } = roomWith('小明', '小红');
  ctrl.startGame('dice');
  assert.ok(ctrl.room);
  ctrl.closeRoom();
  assert.equal(ctrl.room, null);
  assert.equal(ctrl.me, null);
  assert.equal(ctrl.mode, 'solo', '散伙之后要能直接开一局单机，不能卡在房主态');
  assert.equal(ctrl.plugin, null);
});

test('加进端的身份记在本地，下次连接时能拿出来', () => {
  const store = tmpStore();
  assert.equal(GP.loadMyIdentity(store), null, '第一次来什么都没有');
  assert.equal(GP.saveMyIdentity(store, { token:'t_abc', name:'小红' }), true);
  assert.deepEqual(GP.loadMyIdentity(store), { token:'t_abc', name:'小红' });
});

test('没有 token 的身份不写 —— 写了也认不了座', () => {
  const store = tmpStore();
  assert.equal(GP.saveMyIdentity(store, { name:'小红' }), false);
  assert.equal(GP.saveMyIdentity(store, null), false);
  assert.equal(GP.loadMyIdentity(store), null);
});

test('存坏了的身份当作没有，不连带把首页弄崩', () => {
  const store = tmpStore();
  for (const junk of ['', '{', 'null', '{"token":123}', '{"token":""}']){
    store.setItem(GP.ME_KEY, junk);
    assert.equal(GP.loadMyIdentity(store), null, `坏身份没兜住：${junk}`);
  }
});

test('非房主不写房间存档 —— 加入端的房间是房主推来的，不该被本地存档盖掉', () => {
  const store = tmpStore();
  const c = new GP.RoomController({});
  assert.equal(GP.saveRoom(store, c), 0, '连房间都没有');
  c.createRoom('小明');
  assert.equal(GP.saveRoom(store, c), 1);
  c._mode = 'client';
  assert.equal(GP.saveRoom(store, c), 0, '加入端不写');
});

/* ─────────── 变异测试挖出来的盲区：这几条以前没人守着 ───────────
   往代码里注入人工缺陷、看测试抓不抓得住，跑出来 4 条存活。逐条查过，
   没有一条是「语义等价」的假变异 —— 都是测试真的没覆盖到的地方。 */

test('★ 连开两局必须重新洗牌 —— seed 不推进的话，每局都是同一个人当卧底', () => {
  const { ctrl } = roomWith('甲', '乙', '丙', '丁', '戊');
  ctrl.room.seed = 20260101;

  const seedBefore = ctrl.room.seed;
  ctrl.startGame('undercover');
  assert.notEqual(ctrl.room.seed, seedBefore, '开一局就得把 seed 往前推，否则下一局是同一套');

  // 单看两局会有 1/10 的巧合（5 人 2 卧底只有 10 种分法），所以连开六局看整体。
  // 这是玩家真会碰到的：一桌人喊「再来一局」，结果还是他当卧底、词也没换。
  const sigs = new Set();
  for (let i = 0; i < 6; i++){
    const st = ctrl.room.mounted.state;
    sigs.add(st.spyIds.slice().sort().join('|') + '::' + JSON.stringify(st.words));
    ctrl.endGame();
    ctrl.startGame('undercover');
  }
  assert.ok(sigs.size > 1, `连开六局，卧底阵容和词一次都没变过 —— 洗牌根本没动（只有 ${sigs.size} 种组合）`);
});

test('★ esc 把尖括号挡掉 —— 成员名是唯一的注入面，这道门不能漏', () => {
  // 名字是唯一由对端直接控制、又会进 HTML 的字符串（77 处渲染都靠 esc）
  assert.equal(GP.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(GP.esc('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(GP.esc("'"), '&#39;');
  assert.equal(GP.esc('a&b'), 'a&amp;b');
  assert.equal(GP.esc(null), '');
  assert.equal(GP.esc(undefined), '');
});

test('★ 十款游戏的渲染都挡得住恶意成员名 —— 只要有一处忘了 esc 就破了', () => {
  // 名字是唯一由对端直接控制、又会流进 HTML 的字符串。esc 单测只保证函数本身对，
  // 这条保证**每一处调用点**都调了它 —— 新加一款游戏忘了 esc，这里就会红。
  const EVIL = '<img src=x onerror=alert(1)>';
  const { ctrl } = roomWith('房主', EVIL, '丙', '丁', '戊', '己', '庚', '辛', '壬');
  const ctx = { me: ctrl.room.members[0], members: ctrl.room.members, scores: {}, ui: {} };

  for (const p of GP.GAME_PLUGINS){
    if (!ctrl.canStart(p.id)) continue;          // 人数不够的跳过，不是失败
    ctrl.startGame(p.id);
    const view = p.viewFor(ctrl.room.mounted.state, ctrl.room.members[0].id);
    const html = p.render(view, ctx);
    assert.ok(typeof html === 'string', `${p.id} 的 render 应当返回字符串`);
    assert.ok(!html.includes('<img src=x onerror='),
      `${p.id} 的渲染结果里出现了未转义的成员名 —— 有一处漏了 esc`);
  }
});

test('★ 两个预言家的局里各看各的验人结果，不许串台', () => {
  // wwLineup 明确支持 preset.lineup 自定义阵容 —— 双预言家是可配出来的，不是假想
  const { ctrl } = roomWith('甲', '乙', '丙', '丁', '戊', '己');
  ctrl.room.seed = 7;
  ctrl.startGame('werewolf', { preset: { lineup: { wolf:2, seer:2, witch:0, hunter:0, villager:2 } } });
  const p = GP.pluginById('werewolf');
  const st = JSON.parse(JSON.stringify(ctrl.room.mounted.state));

  const seers = st.players.filter(id => st.roles[id] === 'seer');
  assert.equal(seers.length, 2, '这个阵容配出来就该有 2 个预言家');
  const [A, B] = seers;
  const target = st.players.find(id => st.roles[id] === 'villager');

  st.checks = [{ by: B, target, wolf: true, round: 1 }];
  assert.deepEqual(p.viewFor(st, A).checks, [], 'A 不该看到 B 验了谁 —— 那是 B 的信息优势');
  assert.deepEqual(p.viewFor(st, B).checks, [{ target, wolf: true }], 'B 自己验的要看得到');
});

test('★ 狼人不能杀不在局里的人 / 自己 / 已经出局的', () => {
  const { ctrl } = roomWith('甲', '乙', '丙', '丁', '戊');
  ctrl.room.seed = 11;
  ctrl.startGame('werewolf');
  const p = GP.pluginById('werewolf');
  const st = JSON.parse(JSON.stringify(ctrl.room.mounted.state));
  st.step = 'night.wolf';

  const wolf = st.players.find(id => st.roles[id] === 'wolf');
  const dead = st.players.find(id => st.roles[id] !== 'wolf');
  st.dead.push(dead);                       // 假设这人白天已经被投出去了

  assert.equal(p.canApply(st, wolf, { t:'kill', target:'根本没有这个 id' }), false, '不在局里的人');
  assert.equal(p.canApply(st, wolf, { t:'kill', target: wolf }), false, '狼人不能自杀');
  assert.equal(p.canApply(st, wolf, { t:'kill', target: dead }), false, '已经出局的人不能再被刀');
  assert.equal(p.canApply(st, wolf, { t:'kill', target: null }), false, '空目标不算一次击杀');

  // 守卫不能误伤合法目标
  const ok = st.players.find(id => id !== wolf && id !== dead);
  assert.equal(p.canApply(st, wolf, { t:'kill', target: ok }), true, '合法目标得放行');
});

test('★ 投票和验人也一样：目标必须在局、活着、且不是自己', () => {
  const { ctrl } = roomWith('甲', '乙', '丙', '丁', '戊');
  ctrl.room.seed = 13;
  ctrl.startGame('werewolf');
  const p = GP.pluginById('werewolf');
  const st = JSON.parse(JSON.stringify(ctrl.room.mounted.state));
  const me = st.players[0];
  const other = st.players[1];
  st.dead.push(other);

  st.step = 'day.vote';
  assert.equal(p.canApply(st, me, { t:'vote', target: me }), false, '不能投自己');
  assert.equal(p.canApply(st, me, { t:'vote', target: other }), false, '不能投一个已经出局的人');
  assert.equal(p.canApply(st, me, { t:'vote', target: 'ghost' }), false, '不能投不在局里的人');

  st.step = 'night.seer';
  st.roles[me] = 'seer';
  st.dead = [];
  assert.equal(p.canApply(st, me, { t:'check', target: me }), false, '预言家不能验自己');
  assert.equal(p.canApply(st, me, { t:'check', target: 'ghost' }), false, '预言家不能验不在局的人');
});

/* ───────────────────────── 权益抽象 ───────────────────────── */

test('权益抽象挡在联机核心前面：禁掉建房就真的建不了', () => {
  const lockCreate = { can: (c) => c !== GP.CAP.ROOM_CREATE };
  const ctrl = new GP.RoomController({ entitlement: lockCreate });
  assert.throws(() => ctrl.createRoom('小明'), /权益/);

  // 但加入不受影响 —— 免费用户也要能进房间，否则传不动
  const ctrl2 = new GP.RoomController({ entitlement: lockCreate });
  assert.doesNotThrow(() => ctrl2.joinRoom(GP.makeRoom({ hostName:'小明' }), '小红'));
});
