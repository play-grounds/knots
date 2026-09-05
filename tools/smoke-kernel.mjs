// Smoke test: feed a real BLAKE2b-chain block to the *unmodified* bitcoin-kernel
// engine, step by step, and report where it breaks — next to what this repo's
// own header-v2 codec makes of the same bytes. Useful for measuring progress on
// plan step 2 (patching the kernel's header codec / hash / PoW dispatch).
//
//   node tools/smoke-kernel.mjs [height]        (default: explorer tip)
//
// env:
//   ESPLORA  esplora-style API root (default: mempool.guide testnet4)
//   KERNEL   path to @bitcoin-kernel/kernel index.js (default: local mirror)
import { decodeHeaderV2, hashHeaderV2, checkProofOfWorkV2, hexToBytes } from '../src/header-v2.js';

const API = process.env.ESPLORA ?? 'https://mempool.guide/testnet4/api';
const KERNEL = process.env.KERNEL ?? `${process.env.HOME}/remote/github.com/bitcoin-kernel/kernel/packages/kernel/index.js`;
const { createKernel } = await import(KERNEL);

const get = async (p, bin = false) => {
  const r = await fetch(`${API}${p}`);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return bin ? new Uint8Array(await r.arrayBuffer()) : r.text();
};
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const height = Number(process.argv[2] ?? (await get('/blocks/tip/height')));
const hash = (await get(`/block-height/${height}`)).trim();
const headerHex = (await get(`/block/${hash}/header`)).trim();
const blockHex = toHex(await get(`/block/${hash}/raw`, true));
const HEADER_V2_HEX = 164 * 2;

let fails = 0;
const step = (name, fn) => {
  try { const r = fn(); console.log(`ok    ${name}: ${r}`); return r; }
  catch (e) { fails++; console.log(`FAIL  ${name}: ${String(e.message).split('\n')[0].slice(0, 140)}`); return undefined; }
};
const rules = (r) => r.results.map((x) => `${x.ok ? 'ok  ' : 'FAIL'} ${x.label}${x.error ? ' — ' + x.error : ''}`).join('\n        ');

console.log(`height ${height}  hash ${hash}\nheader ${headerHex.length / 2} bytes, block ${blockHex.length / 2} bytes\n`);

console.log('--- this repo: src/header-v2.js');
const h2 = decodeHeaderV2(hexToBytes(headerHex));
const ours = hashHeaderV2(h2);
console.log(`ok    decodeHeaderV2: height=${h2.height} txCount=${h2.txCount} flags=${h2.flags} bits=${h2.bits.toString(16)}`);
console.log(`${ours === hash ? 'ok   ' : (fails++, 'FAIL ')} hashHeaderV2 == explorer hash`);
console.log(`${checkProofOfWorkV2(h2) ? 'ok   ' : (fails++, 'FAIL ')} checkProofOfWorkV2`);

console.log('\n--- unmodified bitcoin-kernel: raw v2 bytes');
const { codec, headers: he, blocks: be } = createKernel();
step('codec.decode(BlockHeader, 164 bytes)', () => JSON.stringify(codec.decode('BlockHeader', headerHex)).slice(0, 100));
step('codec.blockHash(header)', () => codec.blockHash(codec.decode('BlockHeader', headerHex)));
step('codec.checkProofOfWork(header)', () => codec.checkProofOfWork(codec.decode('BlockHeader', headerHex)));
step('he.validateChain([header])', () => JSON.stringify(he.validateChain([codec.decode('BlockHeader', headerHex)], { startHeight: height })).slice(0, 100));
step('codec.decode(Block, full block)', () => codec.decode('Block', blockHex).transactions.length + ' transactions');

console.log('\n--- unmodified bitcoin-kernel: v2 header truncated to 80 bytes + real tx section');
const synthetic = headerHex.slice(0, 160) + blockHex.slice(HEADER_V2_HEX);
const b = step('codec.decode(Block, synthetic)', () => codec.decode('Block', synthetic)) && codec.decode('Block', synthetic);
if (b) {
  const txids = b.transactions.map((t) => codec.txid(t));
  const nodeTxids = JSON.parse(await get(`/block/${hash}/txids`));
  console.log(`${txids.join() === nodeTxids.join() ? 'ok   ' : (fails++, 'FAIL ')} txids match explorer (${txids.length})`);
  const s = be.validateBlockStructure(b);
  console.log(`${s.ok ? 'ok   ' : (fails++, 'FAIL ')} validateBlockStructure\n        ${rules(s)}`);
  const c = be.validateBlockContext(b, { height });
  console.log(`info  validateBlockContext (no UTXO set: prevout-dependent rules cannot pass)\n        ${rules(c)}`);
  const w = be.blockWeight(b);
  console.log(`info  blockWeight ${w} (+${(164 - 80) * 4} for the v2 header = ${w + 336}; node counts the 164-byte header)`);
  console.log(`info  SHA256d hash of the 80-byte prefix: ${codec.blockHash(b.header)} (not the block hash, by design)`);
}

console.log(`\n${fails} failing step(s) — the expected failures are the kernel's header decode, hash, PoW, and Block decode on raw v2 bytes`);
