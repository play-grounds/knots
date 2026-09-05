// Validate the tip of a Knots BLAKE2b chain with the schema engine + the Knots
// overlay: the last N headers through HeaderEngine.validateChain (prev-link,
// PoW, difficulty, MTP, future-time, version, and the fork rules) and the tip
// block through BlockEngine.validateBlockStructure (base + fork rules).
// Data comes from a local Knots node via bitcoin-cli.
//
//   node tools/validate-tip.mjs testnet4|mainnet [headers=12] [blocks=1]
// With blocks > 1, the last `blocks` blocks are each validated structurally and
// reported as a table (the tip block also gets the rule-by-rule listing).
// env: SCHEMA (path to the bitcoin-desktop/schema checkout)
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const SCHEMA = process.env.SCHEMA ?? `${process.env.HOME}/bitcoin-desktop/schema`;
const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));

const which = process.argv[2] ?? 'testnet4';
const N = Number(process.argv[3] ?? 12);
const M = Number(process.argv[4] ?? 1);
const NODES = {
  testnet4: { network: 'btc:testnet4-blake2b', cli: [`${process.env.HOME}/bitcoin-knots/src/build/bin/bitcoin-cli`, `-conf=${process.env.HOME}/knots-testnet4/bitcoin.conf`] },
  mainnet: { network: 'btc:mainnet-blake2b', cli: [`${process.env.HOME}/bitcoin-knots/src/build/bin/bitcoin-cli`, `-conf=${process.env.HOME}/knots-mainnet/bitcoin.conf`] },
};
const { network, cli } = NODES[which];
const rpc = (...a) => { const o = execFileSync(cli[0], [...cli.slice(1), ...a]).toString().trim(); try { return JSON.parse(o); } catch { return o; } };

const k = createKernel({
  core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
  chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'),
  network, overlays: [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))],
});

const tip = rpc('getblockcount');
const hashes = Array.from({ length: N + 11 }, (_, i) => rpc('getblockhash', String(tip - N - 10 + i)));
const headers = hashes.map((h) => k.codec.decode('BlockHeader', rpc('getblockheader', h, 'false')));
const prevContext = headers.slice(0, 11), window = headers.slice(11);
const startHeight = tip - N + 1;
const mark = (ok) => ok === true ? 'ok  ' : ok === false ? 'FAIL' : 'skip';

console.log(`${network}  tip ${tip}  engine ${SCHEMA}\n`);
console.log(`headers ${startHeight}..${tip} (11 earlier headers as MTP context)`);
const res = k.headers.validateChain(window, { startHeight, prevContext, now: Math.floor(Date.now() / 1000) });
let bad = 0;
for (const r of res) {
  const fails = r.results.filter((x) => x.ok === false);
  bad += fails.length;
  const skips = r.results.filter((x) => x.ok === null).map((x) => x.label);
  console.log(`  ${fails.length ? 'FAIL' : 'ok  '} ${r.height} ${r.hash.slice(0, 16)} v2=${(headers[0].version >>> 0) >= 0 && r.height >= k.params.blake2bHeight} ${fails.map((f) => f.label + ':' + f.error).join(' ')}${skips.length ? ' (skipped: ' + skips.join(', ') + ')' : ''}`);
}
console.log(`  rules per header: ${res[0].results.length} (${res[0].results.filter((x) => x.rule.startsWith('knots:')).length} fork rules)`);

if (M > 1) {
  const fmt = (t) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');
  console.log(`\nlast ${M} blocks\n| height | hash | time (UTC) | txs | weight | header rules | block rules | fork rules | node agrees |\n|---|---|---|---|---|---|---|---|---|`);
  let blockFails = 0;
  for (let i = M - 1; i >= 0; i--) {
    const h = tip - i, hash = hashes.at(-1 - i);
    const hdr = res[res.length - 1 - i];
    const block = k.codec.decode('Block', rpc('getblock', hash, '0'));
    const info = rpc('getblock', hash);
    const st = k.blocks.validateBlockStructure(block);
    const forkRules = [...hdr.results, ...st.results].filter((r) => r.rule.startsWith('knots:'));
    const agree = k.codec.blockHash(block.header) === info.hash && k.blocks.blockWeight(block) === info.weight && block.transactions.length === info.nTx;
    const cell = (rs) => `${rs.filter((r) => r.ok === true).length}/${rs.length}${rs.some((r) => r.ok === false) ? ' FAIL' : ''}`;
    if (!st.ok || !agree) blockFails++;
    console.log(`| ${h} | ${hash.slice(0, 16)}… | ${fmt(block.header.time)} | ${block.transactions.length} | ${k.blocks.blockWeight(block)} | ${cell(hdr.results)} | ${cell(st.results)} | ${cell(forkRules)} | ${agree ? 'yes' : 'NO'} |`);
  }
  bad += blockFails;
}

console.log(`\nblock ${tip} ${hashes.at(-1)}`);
const block = k.codec.decode('Block', rpc('getblock', hashes.at(-1), '0'));
const s = k.blocks.validateBlockStructure(block);
for (const r of s.results) console.log(`  ${mark(r.ok)} ${r.rule}${r.error ? ' — ' + r.error : ''}`);
const info = rpc('getblock', hashes.at(-1));
console.log(`  hash ${k.codec.blockHash(block.header) === info.hash ? 'matches' : 'DIFFERS'}, txs ${block.transactions.length} (node ${info.nTx}), weight ${k.blocks.blockWeight(block)} (node ${info.weight}), merkle ${k.codec.merkleRoot(block.transactions.map((t) => k.codec.txid(t))) === info.merkleroot ? 'matches' : 'DIFFERS'}`);
const ctx = k.blocks.validateBlockContext(block, { height: tip, mtp: rpc('getblockheader', hashes.at(-2)).mediantime });
console.log(`  context rules (no UTXO set): ${ctx.results.map((r) => mark(r.ok).trim() + ' ' + r.label).join(', ')}`);
console.log(`\n${bad === 0 && s.ok ? 'VALID' : 'INVALID'}: ${bad} header rule failures, block structure ${s.ok ? 'ok' : 'FAILED'}`);
process.exit(bad === 0 && s.ok ? 0 : 1);
