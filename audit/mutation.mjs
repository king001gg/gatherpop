/**
 * 变异测试：往 index.html 里注入人工缺陷，看现有测试能不能抓住。
 *
 * 这是衡量「测试有效性」的客观指标 —— 覆盖率只说明代码被执行过，
 * 变异得分才说明断言真的在把关。
 *
 *   node audit/mutation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const target = join(root, 'index.html');
const original = readFileSync(target, 'utf8');

/** 每条变异：{ id, area, why, from, to }
    from 必须在文件里**唯一**出现，否则跳过（避免误改）。 */
const MUTANTS = [
  // ── 隐藏信息边界（最要紧的一类） ──
  { id:'uc-leak-all-words', area:'viewFor/谁是卧底', why:'把我的词换成所有人的词表',
    from:'myWord: state.words[viewerId] || null,', to:'myWord: state.words,' },
  { id:'uc-always-reveal-spies', area:'viewFor/谁是卧底', why:'结算前也把卧底名单发出去',
    from:'spyIds: reveal ? state.spyIds : null,', to:'spyIds: state.spyIds,' },
  { id:'uc-always-reveal-pair', area:'viewFor/谁是卧底', why:'结算前把词对发出去',
    from:'pair: reveal ? state.pair : null,', to:'pair: state.pair,' },
  { id:'ww-always-reveal-roles', area:'viewFor/狼人杀', why:'结算前把身份表发给所有人',
    from:'roles: over ? { ...state.roles } : null,', to:'roles: { ...state.roles },' },
  { id:'ww-leak-pack-to-all', area:'viewFor/狼人杀', why:'把狼队名单发给所有人',
    from:"if (role === 'wolf') view.pack = state.players.filter(id => state.roles[id] === 'wolf');",
    to:'view.pack = state.players.filter(id => state.roles[id] === \'wolf\');' },
  { id:'ww-leak-seer-checks', area:'viewFor/狼人杀', why:'把验人结果发给所有人',
    from:'view.checks = state.checks.filter(c => c.by === me).map(c => ({ target:c.target, wolf:c.wolf }));',
    to:'view.checks = state.checks.map(c => ({ target:c.target, wolf:c.wolf }));' },
  { id:'dg-leak-word', area:'viewFor/你画我猜', why:'把要画的词发给猜的人',
    from:'word: (isDrawer || reveal) ? state.word : null,', to:'word: state.word,' },
  { id:'dg-leak-correct-guess', area:'viewFor/你画我猜', why:'把猜对的那条文本（=答案）发出去',
    from:'text: g.correct ? null : g.text,', to:'text: g.text,' },

  // ── 房间快照 / 座位凭据 ──
  { id:'snapshot-leak-token', area:'snapshot', why:'把成员 token 塞进广播快照',
    from:'members: r.members.map(m => ({ id:m.id, name:m.name, isHost:m.isHost, connected:m.connected })),',
    to:'members: r.members.map(m => ({ id:m.id, name:m.name, isHost:m.isHost, connected:m.connected, token:m.token })),' },
  { id:'claim-host-seat', area:'认座/授权', why:'允许认走房主的座位',
    from:'if (!m || m.id === this.room.hostId) return null;', to:'if (!m) return null;' },
  { id:'claim-live-seat', area:'认座/授权', why:'允许顶掉一个有活人的座位',
    from:'if (this._isSeatLive(m.id)) return null;', to:'' },

  // ── 入站报文的守卫（本轮审计新加的） ──
  { id:'no-msg-guard', area:'协议健壮性', why:'不挡住非对象报文（对端发 `null` 就崩）',
    from:'if (!msg || typeof msg !== \'object\') return;', to:'' },
  { id:'no-action-guard', area:'协议健壮性', why:'不挡住非对象动作（action:null 就崩）',
    from:'if (!action || typeof action !== \'object\') return false;', to:'' },

  // ── 越权 ──
  { id:'skip-anyone-can', area:'授权', why:'任何人（含加入端）都能跳人',
    from:'if (actorId !== room.hostId) return false;\n      if (typeof p.skip !== \'function\') return false;',
    to:'if (typeof p.skip !== \'function\') return false;' },

  // ── 持久化 ──
  { id:'save-no-ttl', area:'持久化', why:'存档永不过期',
    from:'if (!Number.isFinite(data.savedAt) || now - data.savedAt > ROOM_TTL_MS){',
    to:'if (false){' },
  { id:'load-no-host-check', area:'持久化', why:'不校验房主还在成员里就放行',
    from:'if (!r.members.some(m => m && m.id === r.hostId)){ dropSavedRoom(store); return null; }',
    to:'' },
  { id:'load-keep-dead-game', area:'持久化', why:'放行一个插件已不存在的进行中局面',
    from:'const okGame = r.mounted && pluginById(r.mounted.gameId) && r.mounted.state\n              && typeof r.mounted.state === \'object\';',
    to:'const okGame = true;' },

  // ── 转义 / XSS ──
  { id:'esc-no-tags', area:'转义', why:'esc 不过滤尖括号',
    from:".replace(/</g,'&lt;').replace(/>/g,'&gt;')", to:'.replace(/不可达/g,"")' },

  // ── 随机性可复现 ──
  { id:'seed-not-advanced', area:'确定性', why:'开局之后不推进 seed，下一局会复用同一串随机数',
    from:'this.room.seed = nextSeed(this.room.seed);', to:'' },

  // ── 规则正确性 ──
  { id:'uc-spycount-off', area:'规则/谁是卧底', why:'卧底人数算错',
    from:'function spyCountFor(n){', to:'function spyCountFor(n){ return 9;' },
  { id:'gomoku-win-at-off', area:'规则/五子棋', why:'连五判定差一',
    from:'function gomokuWinAt(', to:'function gomokuWinAt(){ return null; } function _deadGomokuWinAt(' },
  { id:'ww-kill-target-unguarded', area:'规则/狼人杀', why:'狼人可以不选合法目标就杀人',
    from:"case 'kill':    return state.step === 'night.wolf'  && alive && role === 'wolf' && targetOk(action.target);",
    to:"case 'kill':    return state.step === 'night.wolf'  && alive && role === 'wolf';" },
];

function runTests(){
  try {
    const out = execSync('npm test', { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    const m = out.match(/fail (\d+)/);
    return { failed: m ? Number(m[1]) : 0, raw: out };
  } catch (e){
    const out = (e.stdout || '') + (e.stderr || '');
    const m = out.match(/fail (\d+)/);
    return { failed: m ? Number(m[1]) : 1, raw: out };
  }
}

function tryMutate(mut){
  const count = original.split(mut.from).length - 1;
  if (count !== 1) return { status: 'SKIP', note: `锚点在原文里出现 ${count} 次（要求恰好 1 次）` };
  const mutated = original.replace(mut.from, mut.to);
  if (mutated === original) return { status: 'SKIP', note: '替换后内容没变' };
  writeFileSync(target, mutated, 'utf8');
  const r = runTests();
  return { status: r.failed > 0 ? 'KILLED' : 'SURVIVED', failed: r.failed, raw: r.raw };
}

/* 全流程包在函数里，早退一律用 return —— 这样收尾只用设 exitCode，
   不必调 process.exit()。后者会把还没冲出去的 stdout 一起带走，
   而失败时人正需要看那份报告。 */
function main(){
  // 预检：锚点必须唯一，否则这条变异测的不是它想测的东西
  {
    let bad = 0;
    for (const mut of MUTANTS){
      const c = original.split(mut.from).length - 1;
      if (c !== 1){ console.log(`锚点异常：${mut.id} 出现 ${c} 次`); bad++; }
    }
    if (bad){ console.log(`\n${bad} 条锚点有问题，先修正再跑。`); process.exitCode = 1; return; }
    console.log(`锚点预检通过（${MUTANTS.length} 条）\n`);
  }

  console.log('先确认基线是绿的…');
  const base = runTests();
  console.log(`基线：fail=${base.failed}\n`);
  if (base.failed !== 0){
    console.log('基线不是绿的，先修好再跑变异测试。');
    process.exitCode = 1;
    return;
  }

  const rows = [];
  try {
    for (const mut of MUTANTS){
      process.stdout.write(`  ${mut.id.padEnd(26)} `);
      let r;
      try { r = tryMutate(mut); }
      catch (e){ r = { status: 'ERROR', note: String(e.message) }; }
      finally { writeFileSync(target, original, 'utf8'); }
      const tag = { KILLED:'✅ 抓住', SURVIVED:'❌ 漏掉', SKIP:'⏭ 跳过', ERROR:'💥 出错' }[r.status];
      console.log(`${tag}${r.note ? ' — ' + r.note : (r.failed ? `（${r.failed} 个测试失败）` : '（全部测试仍然通过）')}`);
      rows.push({ ...mut, ...r });
    }
  } finally {
    writeFileSync(target, original, 'utf8');    // 出了什么事都得把 index.html 还原
    console.log('\n已还原 index.html');
  }

  const killed = rows.filter(r => r.status === 'KILLED').length;
  const survived = rows.filter(r => r.status === 'SURVIVED').length;
  const skipped = rows.filter(r => r.status !== 'KILLED' && r.status !== 'SURVIVED').length;

  console.log(`\n变异得分：${killed}/${killed + survived} = ${(100 * killed / Math.max(1, killed + survived)).toFixed(1)}%`);
  if (skipped) console.log(`（另有 ${skipped} 条未能应用，见上）`);

  if (survived){
    console.log('\n存活的变异 —— 这些都是测试的盲区：');
    for (const r of rows.filter(x => x.status === 'SURVIVED')){
      console.log(`  ❌ [${r.area}] ${r.why}`);
      console.log(`     ${r.id}`);
    }
  }

  /* 给 CI 当门禁用：有存活、或有没跑成的，就以非 0 退出。
     注意「存活」不一定都是洞 —— 也可能是语义等价的变异（那种该从 MUTANTS 里删掉，
     而不是把这里放宽）。所以这道门是**手动触发**的，红了要人来判断。 */
  process.exitCode = (survived || skipped) ? 1 : 0;
}

main();
