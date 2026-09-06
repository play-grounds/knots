// Seal post-fork epochs of a BLAKE2b chain into static files for epochs.html:
//   data/epochs/<net>/<n>.bin   headers of epoch n in height order (80 or 164 bytes each)
//   data/epochs/<net>/index.json  one entry per epoch: range, count, times, bits, size, sha256,
//                                  and the context headers the engine needs to verify the epoch
//                                  on its own (11 headers before it, plus any lookback the
//                                  difficulty rules ask for, discovered by running the engine).
// Complete epochs are written once and never change; the current epoch is rewritten each run.
//
//   node tools/export-epochs.mjs [testnet4|mainnet|all]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SCHEMA = process.env.SCHEMA ?? `${process.env.HOME}/bitcoin-desktop/schema`;
const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));
const INTERVAL = 2016;
const NODES = {
  testnet4: { network: 'btc:testnet4-blake2b', cookie: `${process.env.HOME}/knots-testnet4/data/testnet4/.cookie`, port: 48342, lastShared: 150307 },
  mainnet: { network: 'btc:mainnet-blake2b', cookie: `${process.env.HOME}/knots-mainnet/data/.cookie`, port: 8332, lastShared: 961631 },
};
async function rpcClient(cfg) {
  const auth = 'Basic ' + Buffer.from((await readFile(cfg.cookie, 'utf8')).trim()).toString('base64');
  return async (calls) => {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))) });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    return (await r.json()).sort((a, b) => a.id - b.id).map((x) => { if (x.error) throw new Error(x.error.message); return x.result; });
  };
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

for (const net of (process.argv[2] ?? 'all') === 'all' ? Object.keys(NODES) : [process.argv[2]]) {
  const cfg = NODES[net], rpc = await rpcClient(cfg);
  const k = createKernel({ core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network: cfg.network, overlays: [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))] });
  const hexAt = async (hs) => { const out = []; for (const c of chunk(hs, 500)) { const hashes = await rpc(c.map((h) => ['getblockhash', [h]])); out.push(...await rpc(hashes.map((h) => ['getblockheader', [h, false]]))); } return out; };
  const [tip] = await rpc([['getblockcount', []]]);
  const forkHeight = cfg.lastShared + 1;
  const firstEpoch = Math.floor(forkHeight / INTERVAL), lastEpoch = Math.floor(tip / INTERVAL);
  const dir = `data/epochs/${net}`; await mkdir(dir, { recursive: true });
  let index = []; try { index = JSON.parse(await readFile(`${dir}/index.json`, 'utf8')).epochs; } catch {}
  const epochs = [];
  for (let n = firstEpoch; n <= lastEpoch; n++) {
    const start = n * INTERVAL, end = Math.min(start + INTERVAL - 1, tip), complete = end === start + INTERVAL - 1;
    const existing = index.find((e) => e.n === n);
    if (existing?.complete) { epochs.push(existing); console.log(`${net} epoch ${n}: sealed, unchanged`); continue; }
    const ctxStart = start - 11;
    const hexes = await hexAt(Array.from({ length: end - ctxStart + 1 }, (_, i) => ctxStart + i));
    const headers = hexes.map((h) => k.codec.decode('BlockHeader', h));
    const epochHexes = hexes.slice(11), prev = hexes.slice(0, 11);
    // context the engine asks for beyond the 11 previous headers (epoch-first for the retarget, min-difficulty walk-backs)
    const extra = {};
    for (let round = 0; round < 10; round++) {
      const missing = new Set();
      const chainAt = (h) => { if (extra[h]) return k.codec.decode('BlockHeader', extra[h]); missing.add(h); return null; };
      const res = k.headers.validateChain(headers.slice(11), { startHeight: start, prevContext: headers.slice(0, 11), now: Math.floor(Date.now() / 1000), chainAt });
      if (!missing.size) {
        const fails = res.flatMap((r) => r.results.filter((x) => x.ok === false).map((x) => `${r.height} ${x.rule}: ${x.error}`));
        if (fails.length) throw new Error(`engine rejects epoch ${n}:\n${fails.join('\n')}`);
        const bin = Buffer.concat(epochHexes.map((h) => Buffer.from(h, 'hex')));
        await writeFile(`${dir}/${n}.bin`, bin);
        const first = headers[11], last = headers.at(-1);
        const e = {
          n, start, end, count: epochHexes.length, complete,
          firstHash: res[0].hash, lastHash: res.at(-1).hash, firstTime: first.time, lastTime: last.time,
          firstBits: first.bits.toString(16), lastBits: last.bits.toString(16), chainWork: res.at(-1).chainWork.toString(16),
          v2From: res.find((r, i) => (headers[11 + i].version >>> 31) === 1)?.height ?? null,
          bytes: bin.length, sha256: createHash('sha256').update(bin).digest('hex'),
          file: `${n}.bin`, sealed: complete ? new Date().toISOString() : null, updated: new Date().toISOString(),
          context: { prev, extra },
        };
        epochs.push(e);
        console.log(`${net} epoch ${n}: ${start}..${end} ${e.count}/${INTERVAL} ${complete ? 'sealed' : 'in progress'}, ${bin.length} bytes, sha256 ${e.sha256.slice(0, 16)}…`);
        break;
      }
      const hs = [...missing].sort((a, b) => a - b);
      (await hexAt(hs)).forEach((hex, i) => { extra[hs[i]] = hex; });
    }
  }
  await writeFile(`${dir}/index.json`, JSON.stringify({ network: net, interval: INTERVAL, forkHeight, lastShared: cfg.lastShared, tip, updated: new Date().toISOString(), source: 'local Bitcoin Knots node, verified with the schema engine before writing', epochs }, null, 1));
}
