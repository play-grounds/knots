// Seed files for pools.html: every block of a mainnet epoch with its pool attribution,
// from the mempool.guide API (which follows the BLAKE2b chain and attributes coinbases):
//   data/pools/mainnet/<n>.json   { n, start, end, complete, count, updated, blocks: [...] }
// Block records are the page's own shape: { hash, height, prev, time, txs, size, reward, fees, pool, tag, addr }.
// Complete epochs are written once and never change; the current epoch is rewritten each run.
//
//   node tools/export-pools.mjs [epoch-number|all]     (default: the current epoch)
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const API = 'https://mempool.guide/api';
const INTERVAL = 2016, FIRST_EPOCH = 477; // the epoch containing the split from Core
const dir = 'data/pools/mainnet';
const get = async (p) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(`${API}${p}`); if (r.ok) return r.json(); } catch {} await new Promise((r) => setTimeout(r, 1500 * (i + 1))); } throw new Error(`${p}: failed`); };

function coinbaseText(hex) {
  if (!hex) return '';
  const b = Buffer.from(hex, 'hex'); const skip = b[0] >= 1 && b[0] <= 8 ? 1 + b[0] : 0;
  return Array.from(b.subarray(skip), (c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '\0')).join('').split('\0').map((x) => x.trim()).filter((x) => x.length >= 3).join(' · ');
}
const norm = (b) => ({ hash: b.id, height: b.height, prev: b.previousblockhash, time: b.timestamp, txs: b.tx_count, size: b.size,
  reward: b.extras?.reward ?? 0, fees: b.extras?.totalFees ?? 0, pool: b.extras?.pool?.name ?? 'Unknown', tag: coinbaseText(b.extras?.coinbaseRaw), addr: b.extras?.coinbaseAddress ?? '' });

const tip = Number(await (await fetch(`${API}/blocks/tip/height`)).text());
const cur = Math.floor(tip / INTERVAL);
const arg = process.argv[2] ?? String(cur);
const wanted = arg === 'all' ? Array.from({ length: cur - FIRST_EPOCH + 1 }, (_, i) => FIRST_EPOCH + i) : [Number(arg)];
await mkdir(dir, { recursive: true });

for (const n of wanted) {
  const start = n * INTERVAL, end = Math.min(start + INTERVAL - 1, tip), complete = end === start + INTERVAL - 1;
  let existing = null; try { existing = JSON.parse(await readFile(`${dir}/${n}.json`, 'utf8')); } catch {}
  if (existing?.complete) { console.log(`epoch ${n}: sealed, unchanged`); continue; }
  const blocks = new Map((existing?.blocks ?? []).map((b) => [b.height, b]));
  // page down from the highest missing height; each page is 15 blocks ending at the height asked for
  for (;;) {
    let h = end; while (h >= start && blocks.has(h)) h--;
    if (h < start) break;
    const page = await get(`/v1/blocks/${h}`);
    for (const raw of page) { const b = norm(raw); if (b.height >= start && b.height <= end) blocks.set(b.height, b); }
    process.stdout.write(`\repoch ${n}: ${blocks.size}/${end - start + 1} blocks`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const arr = [...blocks.values()].sort((a, b) => a.height - b.height);
  // linkage check within the file; a broken link means a reorg between pages, so drop and refetch on the next run
  for (let i = 1; i < arr.length; i++) if (arr[i].prev !== arr[i - 1].hash) throw new Error(`epoch ${n}: link broken at ${arr[i].height}; run again`);
  const pools = {}; for (const b of arr) pools[b.pool] = (pools[b.pool] ?? 0) + 1;
  await writeFile(`${dir}/${n}.json`, JSON.stringify({ network: 'mainnet', n, start, end, complete, count: arr.length, interval: INTERVAL, updated: new Date().toISOString(), source: 'mempool.guide API, pool attribution by its mining-pools list', pools, blocks: arr }));
  console.log(`\repoch ${n}: ${start}..${end} ${arr.length}/${INTERVAL} ${complete ? 'sealed' : 'in progress'}, ${Object.keys(pools).length} pools`);
}
