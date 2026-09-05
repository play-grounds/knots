// Export the whole post-fork header chain of a BLAKE2b chain from a local
// Knots node as a static file for node.html: data/headers-<net>.bin (raw
// headers, 80 or 164 bytes each, in height order) and data/headers-<net>.json
// (where it starts, the checkpoint, and the few out-of-range headers the
// difficulty rules need, found by running the engine and recording lookups).
//
//   node tools/export-headers.mjs [testnet4|mainnet|all]
import { readFile, writeFile } from 'node:fs/promises';

const SCHEMA = process.env.SCHEMA ?? `${process.env.HOME}/bitcoin-desktop/schema`;
const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));

const NODES = {
  testnet4: { network: 'btc:testnet4-blake2b', cookie: `${process.env.HOME}/knots-testnet4/data/testnet4/.cookie`, port: 48342, lastShared: 150307 },
  mainnet: { network: 'btc:mainnet-blake2b', cookie: `${process.env.HOME}/knots-mainnet/data/.cookie`, port: 8332, lastShared: 961631 },
};
const CONTEXT = 11; // headers before the checkpoint so MTP is checkable from the first post-fork block

async function rpcClient(cfg) {
  const auth = 'Basic ' + Buffer.from((await readFile(cfg.cookie, 'utf8')).trim()).toString('base64');
  return async (calls) => { // batch: [[method, params], ...] -> results in order
    const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
    const r = await fetch(`http://127.0.0.1:${cfg.port}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const out = await r.json();
    return out.sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
  };
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

for (const net of (process.argv[2] ?? 'all') === 'all' ? Object.keys(NODES) : [process.argv[2]]) {
  const cfg = NODES[net];
  const rpc = await rpcClient(cfg);
  const k = createKernel({ core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network: cfg.network, overlays: [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))] });
  const [tip] = await rpc([['getblockcount', []]]);
  const startHeight = cfg.lastShared - CONTEXT;
  const heights = Array.from({ length: tip - startHeight + 1 }, (_, i) => startHeight + i);
  const hexAt = async (hs) => {
    const out = [];
    for (const c of chunk(hs, 500)) {
      const hashes = await rpc(c.map((h) => ['getblockhash', [h]]));
      out.push(...await rpc(hashes.map((h) => ['getblockheader', [h, false]])));
    }
    return out;
  };
  const hexes = await hexAt(heights);
  const headers = hexes.map((h) => k.codec.decode('BlockHeader', h));
  // find the out-of-range headers the rules ask for (epoch firsts, min-difficulty walk-backs)
  const extra = {};
  for (let round = 0; round < 10; round++) {
    const missing = new Set();
    const chainAt = (h) => { if (extra[h]) return k.codec.decode('BlockHeader', extra[h]); missing.add(h); return null; };
    const res = k.headers.validateChain(headers, { startHeight, now: Math.floor(Date.now() / 1000), chainAt });
    if (!missing.size) {
      const fails = res.flatMap((r) => r.results.filter((x) => x.ok === false).map((x) => `${r.height} ${x.rule}: ${x.error}`));
      const nulls = res.slice(CONTEXT).flatMap((r) => r.results.filter((x) => x.ok === null).map((x) => x.rule));
      if (fails.length) throw new Error(`engine rejects the node's chain:\n${fails.join('\n')}`);
      console.log(`${net}: ${headers.length} headers ${startHeight}..${tip} validate; extra context headers: ${Object.keys(extra).length}; skipped rules after checkpoint: ${[...new Set(nulls)].join(', ') || 'none'}; chain work 2^${res.at(-1).chainWork.toString(2).length - 1}`);
      break;
    }
    const hs = [...missing].sort((a, b) => a - b);
    (await hexAt(hs)).forEach((hex, i) => { extra[hs[i]] = hex; });
  }
  const bin = Buffer.concat(hexes.map((h) => Buffer.from(h, 'hex')));
  await writeFile(`data/headers-${net}.bin`, bin);
  const [checkpointHash, tipHash] = await rpc([['getblockhash', [cfg.lastShared]], ['getblockhash', [tip]]]);
  await writeFile(`data/headers-${net}.json`, JSON.stringify({
    network: net, startHeight, count: hexes.length, bytes: bin.length,
    checkpoint: { height: cfg.lastShared, hash: checkpointHash, note: 'last block shared with Bitcoin Core; a hard checkpoint in Knots' },
    tip: { height: tip, hash: tipHash }, extra, exported: new Date().toISOString(),
    source: 'local Bitcoin Knots node (getblockheader), verified with the schema engine before writing',
  }, null, 1));
  console.log(`  -> data/headers-${net}.bin (${bin.length} bytes), data/headers-${net}.json`);
}
