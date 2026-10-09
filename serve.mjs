/**
 * 真机联机测试用的静态服务器。零依赖。
 *
 *   node serve.mjs [端口]
 *
 * 为什么需要它：`index.html` 双击就能单机玩，但**两台设备要联机就必须同源**——
 * 同一个 `file://` 路径在两台机器上是两个来源，BroadcastChannel 和
 * `location.origin` 都对不上。所以真机测试得先把它托管起来，两边开同一个地址。
 *
 * 不需要 HTTPS：这个页面全程不调用 getUserMedia（扫码用的是手机系统相机），
 * 而 WebRTC 数据通道本身不要求安全上下文。
 *
 * 一个坑：**必须用下面打印的局域网地址打开，不能用 localhost**。
 * 邀请链接里的地址是按 `location.origin` 生成的，用 localhost 打开的话，
 * 生成出来的码里写的就是 localhost —— 另一台设备扫了会指向它自己。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';

    // 不许跳出这个目录
    const full = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(root)) { res.writeHead(403).end('不行'); return; }

    const info = await stat(full);
    if (info.isDirectory()) { res.writeHead(404).end('没有这个文件'); return; }

    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      // 改完代码刷新就能看到，别让浏览器拿缓存糊弄人
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个文件');
  }
});

server.listen(port, '0.0.0.0', () => {
  const lan = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []){
      if (a.family === 'IPv4' && !a.internal) lan.push(a.address);
    }
  }

  console.log('\n  围响已经起来了 —— 两台设备开同一个地址：\n');
  for (const ip of lan) console.log(`    http://${ip}:${port}/`);
  console.log(`\n  本机调试用：http://localhost:${port}/`);
  console.log('\n  ⚠ 真机联机请用上面的局域网地址，别用 localhost ——');
  console.log('    邀请链接是按当前地址生成的，用 localhost 生成的码指向的是它自己。\n');
  console.log('  Ctrl+C 停掉。\n');
});
