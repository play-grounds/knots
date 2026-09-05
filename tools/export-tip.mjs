// Export the tip block of a BLAKE2b chain from a local Knots node as a static
// snapshot for block.html (stage 1: no live transport). Writes
// data/tip-<network>.json with the raw block hex, the 11 previous headers (MTP
// and difficulty context), and what the node says about the block so the page
// can show "node agrees".
//
//   node tools/export-tip.mjs [testnet4|mainnet|all] [height]
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const NODES = {
  testnet4: [`${process.env.HOME}/bitcoin-knots/src/build/bin/bitcoin-cli`, `-conf=${process.env.HOME}/knots-testnet4/bitcoin.conf`],
  mainnet: [`${process.env.HOME}/bitcoin-knots/src/build/bin/bitcoin-cli`, `-conf=${process.env.HOME}/knots-mainnet/bitcoin.conf`],
};
const which = process.argv[2] ?? 'all';
const want = Number(process.argv[3] ?? NaN);

for (const net of which === 'all' ? Object.keys(NODES) : [which]) {
  const cli = NODES[net];
  const rpc = (...a) => { const o = execFileSync(cli[0], [...cli.slice(1), ...a], { maxBuffer: 64 << 20 }).toString().trim(); try { return JSON.parse(o); } catch { return o; } };
  const height = Number.isFinite(want) ? want : rpc('getblockcount');
  const hash = rpc('getblockhash', String(height));
  const info = rpc('getblock', hash);
  const prev = Array.from({ length: 11 }, (_, i) => rpc('getblockhash', String(height - 11 + i)));
  const out = {
    network: net, height, hash, exported: new Date().toISOString(),
    source: 'local Bitcoin Knots node (getblock verbosity 0); static snapshot, stage 1',
    node: { nTx: info.nTx, weight: info.weight, size: info.size, time: info.time, mediantime: info.mediantime, merkleroot: info.merkleroot, bits: info.bits },
    prevHeaders: prev.map((h) => rpc('getblockheader', h, 'false')),
    prevMediantime: rpc('getblockheader', prev.at(-1)).mediantime,
    block: rpc('getblock', hash, '0'),
  };
  await writeFile(`data/tip-${net}.json`, JSON.stringify(out));
  console.log(`${net}: ${height} ${hash} ${info.nTx} txs, ${out.block.length / 2} bytes -> data/tip-${net}.json`);
}
