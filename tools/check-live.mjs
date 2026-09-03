// Fetch real BLAKE2b-chain headers from mempool.guide (esplora API) and check
// that our header v2 decode + hash reproduces the explorer's block hash and
// that the hash satisfies the header's own target.
//   node tools/check-live.mjs [height ...]   (default: fork block + tip)
import { decodeHeaderV2, hashHeaderV2, checkProofOfWorkV2, hexToBytes, expandCompact } from '../src/header-v2.js';

const API = process.env.ESPLORA ?? 'https://mempool.guide/api';
const get = async (p) => { const r = await fetch(`${API}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.text(); };

const heights = process.argv.slice(2).map(Number);
if (!heights.length) heights.push(961640, Number(await get('/blocks/tip/height')));

let fail = 0;
for (const height of heights) {
  const hash = (await get(`/block-height/${height}`)).trim();
  const hex = (await get(`/block/${hash}/header`)).trim();
  const h = decodeHeaderV2(hexToBytes(hex));
  const ours = hashHeaderV2(h);
  const pow = checkProofOfWorkV2(h);
  const good = ours === hash && pow && h.height === height;
  if (!good) fail++;
  console.log(`${good ? 'ok  ' : 'FAIL'} height ${height} txCount ${h.txCount} flags ${h.flags} bits ${h.bits.toString(16)} profile ${h.flags & 3}`);
  console.log(`     explorer ${hash}\n     ours     ${ours}  pow ${pow}  target 0x${expandCompact(h.bits).toString(16).padStart(64, '0').slice(0, 20)}…`);
}
process.exit(fail ? 1 : 0);
