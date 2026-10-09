/**
 * 对变异测试里「存活」的 4 条逐条取证：
 * 到底是语义等价的假变异（活该杀不掉），还是真的漏了一个用户能碰到的 bug。
 *
 *   node audit/verify.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(here, '..', 'index.html'), 'utf8');

function loadCore(html){
  const m = html.match(/\/\/ ==== CORE:BEGIN ====([\s\S]*?)\/\/ ==== CORE:END ====/);
  const mod = { exports: {} };
  return new Function('module', 'exports', m[1] + '\n;return GP;')(mod, mod.exports);
}
function loadMutated(from, to){
  const c = original.split(from).length - 1;
  if (c !== 1) throw new Error(`锚点出现 ${c} 次`);
  return loadCore(original.replace(from, to));
}
const BASE = loadCore(original);

function room(GP, names, seed = 999){
  const c = new GP.RoomController({});
  c.createRoom(names[0]);
  for (const n of names.slice(1)) c.room.members.push(GP.makeMember({ name: n }));
  c.room.seed = seed;
  return c;
}
const LINE = '─'.repeat(66);

/* ─────────── 1. seed-not-advanced：连开两局，第二次是不是原样重发 ─────────── */
{
  console.log(`\n${LINE}\n【1】seed 不推进 —— 连着开两局会不会是同一套\n${LINE}`);
  for (const [tag, GP] of [['原始', BASE], ['变异', loadMutated('this.room.seed = nextSeed(this.room.seed);', '')]]){
    const c = room(GP, ['甲','乙','丙','丁','戊']);
    c.startGame('undercover');
    const a = { spies: c.room.mounted.state.spyIds.slice(), words: { ...c.room.mounted.state.words } };
    c.startGame('undercover');                       // 第二局
    const b = { spies: c.room.mounted.state.spyIds.slice(), words: { ...c.room.mounted.state.words } };
    const sameSpies = a.spies.join() === b.spies.join();
    const sameWords = JSON.stringify(a.words) === JSON.stringify(b.words);
    console.log(`  ${tag}：第一局卧底=[${a.spies.map(s=>s.slice(-2))}]  第二局卧底=[${b.spies.map(s=>s.slice(-2))}]`);
    console.log(`        词表相同=${sameWords}   卧底完全相同=${sameSpies}`);
    if (tag === '变异' && sameSpies && sameWords) console.log('        ⚠️  第二局和第一局一模一样 —— 同一个玩家每局都是卧底');
    if (tag === '原始' && !sameSpies) console.log('        ✓  原本每局重新洗牌');
  }
}

/* ─────────── 2. ww-kill-target-unguarded：狼人能杀谁 ─────────── */
{
  console.log(`\n${LINE}\n【2】狼人杀 kill 的 targetOk 守卫 —— 删掉之后能杀谁\n${LINE}`);
  for (const [tag, GP] of [['原始', BASE], ['变异', loadMutated(
      "case 'kill':    return state.step === 'night.wolf'  && alive && role === 'wolf' && targetOk(action.target);",
      "case 'kill':    return state.step === 'night.wolf'  && alive && role === 'wolf';")]]){
    const c = room(GP, ['甲','乙','丙','丁','戊','己']);
    c.startGame('werewolf');
    const p = GP.pluginById('werewolf');
    const st = JSON.parse(JSON.stringify(c.room.mounted.state));
    st.step = 'night.wolf';
    const wolf = st.players.find(id => st.roles[id] === 'wolf');
    const alien = st.players.find(id => st.roles[id] === 'villager');
    const cases = [
      ['不存在的人', 'ghost-id'],
      ['自己（自杀）', wolf],
      ['null（弃权之外的空目标）', null],
    ];
    const out = cases.map(([label, t]) => `${label}=${p.canApply(st, wolf, { t:'kill', target:t })}`);
    console.log(`  ${tag}：狼人指向 ${out.join('  ')}`);
    if (tag === '变异'){
      // 真的走一遍 reduce，看局面变成了什么
      st.night = { ...st.night, wolfVotes: {} };
      const all = st.players.filter(id => st.roles[id] === 'wolf');
      let s = st;
      for (const w of all) s = p.reduce(s, { t:'kill', by:w, target: w === wolf ? 'ghost-id' : 'ghost-id' });
      console.log(`        ⚠️  夜里「被杀」的是：${JSON.stringify(s.night.victim)} —— 一个根本不在局里的人`);
      console.log(`        结果：白天宣布死人时 ${JSON.stringify(s.dead)}`);
    }
  }
}

/* ─────────── 3. ww-leak-seer-checks：两个预言家的局里会不会串 ─────────── */
{
  console.log(`\n${LINE}\n【3】预言家验人结果 —— 自定义双预言家阵容下会不会串台\n${LINE}`);
  for (const [tag, GP] of [['原始', BASE], ['变异', loadMutated(
      'view.checks = state.checks.filter(c => c.by === me).map(c => ({ target:c.target, wolf:c.wolf }));',
      'view.checks = state.checks.map(c => ({ target:c.target, wolf:c.wolf }));')]]){
    // 6 人：2 狼 2 预言家 2 平民 —— wwLineup 明确支持 preset.lineup 自定义阵容
    const c = room(GP, ['甲','乙','丙','丁','戊','己']);
    c.startGame('werewolf', { preset: { lineup: { wolf:2, seer:2, witch:0, hunter:0, villager:2 } } });
    const p = GP.pluginById('werewolf');
    const st = JSON.parse(JSON.stringify(c.room.mounted.state));
    const seers = st.players.filter(id => st.roles[id] === 'seer');
    if (seers.length !== 2){ console.log(`  阵容没生效（预言家 ${seers.length} 个），跳过`); continue; }
    const [A, B] = seers;
    const victim = st.players.find(id => st.roles[id] === 'villager');
    st.checks = [{ by: B, target: victim, wolf: true, round: 1 }];   // B 验出来 victim 是狼
    const va = p.viewFor(st, A);
    const leaked = JSON.stringify(va.checks || []);
    console.log(`  ${tag}：A 的 checks = ${leaked}`);
    if (tag === '变异' && (va.checks || []).some(x => x.target === victim))
      console.log('        ⚠️  A 看到了 B 的验人结果 —— 两个预言家互相顶掉了对方的信息优势');
    if (tag === '原始' && (!va.checks || va.checks.length === 0))
      console.log('        ✓  原本 A 只看得到自己验的');
  }
}

/* ─────────── 4. esc-no-tags：名字里的尖括号 ─────────── */
{
  console.log(`\n${LINE}\n【4】esc 不转义尖括号 —— 成员名会不会变成真标签\n${LINE}`);
  const EVIL = '<img src=x onerror=alert(1)>';
  for (const [tag, GP] of [['原始', BASE], ['变异', loadMutated(
      ".replace(/</g,'&lt;').replace(/>/g,'&gt;')", '.replace(/不可达/g,"")')]]){
    console.log(`  ${tag}：esc(${JSON.stringify(EVIL)}) = ${JSON.stringify(GP.esc(EVIL))}`);
    if (tag === '变异' && GP.esc(EVIL).includes('<img'))
      console.log('        ⚠️  标签原样穿过 —— 成员名注入即可执行脚本');
  }
}

console.log(`\n${LINE}\n`);
