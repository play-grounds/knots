// Export the last N blocks of a BLAKE2b chain from a local Knots node as a
// static window for node.html: data/blocks/<net>/<hash>.bin plus a manifest
// (height, hash, size, sha256). Older files beyond the window are removed so
// the repo stays small. Nothing here is trusted by the page: every block is
// verified against its header on arrival.
//
//   node tools/export-blocks.mjs [testnet4|mainnet|all] [count]
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const NODES = {
  testnet4: { cookie: `${process.env.HOME}/knots-testnet4/data/testnet4/.cookie`, port: 48342, count: 24 },
  mainnet: { cookie: `${process.env.HOME}/knots-mainnet/data/.cookie`, port: 8332, count: 12 },
};
async function rpcClient(cfg) {
  const auth = 'Basic ' + Buffer.from((await readFile(cfg.cookie, 'utf8')).trim()).toString('base64');
  return async (calls) => {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))) });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    return (await r.json()).sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
  };
}
for (const net of (process.argv[2] ?? 'all') === 'all' ? Object.keys(NODES) : [process.argv[2]]) {
  const cfg = NODES[net], rpc = await rpcClient(cfg);
  const count = Number(process.argv[3] ?? cfg.count);
  const dir = `data/blocks/${net}`; await mkdir(dir, { recursive: true });
  const [tip] = await rpc([['getblockcount', []]]);
  const heights = Array.from({ length: count }, (_, i) => tip - count + 1 + i);
  const hashes = await rpc(heights.map((h) => ['getblockhash', [h]]));
  const hexes = await rpc(hashes.map((h) => ['getblock', [h, 0]]));
  const blocks = [];
  for (let i = 0; i < heights.length; i++) {
    const bytes = Buffer.from(hexes[i], 'hex');
    await writeFile(`${dir}/${hashes[i]}.bin`, bytes);
    blocks.push({ height: heights[i], hash: hashes[i], size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const keep = new Set(hashes.map((h) => `${h}.bin`));
  for (const f of await readdir(dir)) if (f.endsWith('.bin') && !keep.has(f)) await unlink(`${dir}/${f}`);
  await writeFile(`${dir}/manifest.json`, JSON.stringify({ network: net, exported: new Date().toISOString(), first: heights[0], last: tip, blocks }, null, 1));
  console.log(`${net}: ${count} blocks ${heights[0]}..${tip}, ${blocks.reduce((a, b) => a + b.size, 0).toLocaleString()} bytes -> ${dir}/`);
}
