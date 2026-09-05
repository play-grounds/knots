// NIP-333 (kind 33333) publisher for the Bitcoin Knots BLAKE2b chains.
// Sibling of bitcoin-desktop/headers' clean-room publisher and reuses its event
// builder, BIP-340 signer and relay pool, so events are byte-compatible.
// Headers come from a local Knots node over RPC and are validated with the
// schema engine + Knots overlay (every header rule, incl. the fork rules)
// before anything is signed: the publisher is a validator first.
//
//   NOSTR_PRIVKEY=<hex|nsec> node tools/publish-nip333.mjs testnet4|mainnet [--once] [--dry-run] [--relays a,b] [--u url]
//   (or `git config nostr.privkey` in this repo; the key is never taken from argv)
//
// Network codes on the wire: tbtc4b2 (testnet4 fork), btcb2 (mainnet fork).
// Content: the last 12 headers, 164 bytes each, ascending; `tip` tag = tip height.
// env: SCHEMA (bitcoin-desktop/schema checkout), HEADERS_REPO (bitcoin-desktop/headers checkout)
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME;
const SCHEMA = process.env.SCHEMA ?? `${HOME}/bitcoin-desktop/schema`;
const HEADERS_REPO = process.env.HEADERS_REPO ?? `${HOME}/remote/github.com/bitcoin-desktop/headers`;
const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
const { parsePrivateKey, publicKey, buildHeadersEvent, RelayPool } = await import(`${HEADERS_REPO}/publisher/nostr.js`);
const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));

const NETWORKS = {
  testnet4: { id: 'btc:testnet4-blake2b', wire: 'tbtc4b2', conf: `${HOME}/knots-testnet4/bitcoin.conf`, poll: 10 },
  mainnet: { id: 'btc:mainnet-blake2b', wire: 'btcb2', conf: `${HOME}/knots-mainnet/bitcoin.conf`, poll: 10 },
};
const HEADERS_COUNT = 12;
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

const args = process.argv.slice(2);
const net = NETWORKS[args[0]];
if (!net) { console.error('usage: publish-nip333.mjs testnet4|mainnet [--once] [--dry-run] [--relays a,b] [--u url]'); process.exit(2); }
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const opts = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const log = (m) => console.log(`[${new Date().toISOString()}] ${net.wire}: ${m}`);
const fail = (m, code = 1) => { console.error(`[${new Date().toISOString()}] ${net.wire}: FATAL ${m}`); process.exit(code); };

// ---- key: env or this repo's git config, never argv ----
let keyInput = process.env.NOSTR_PRIVKEY ?? null;
if (!keyInput) { try { keyInput = execFileSync('git', ['config', 'nostr.privkey'], { cwd: new URL('..', import.meta.url).pathname }).toString().trim(); } catch {} }
if (!keyInput && !flag('dry-run')) fail('no key: set NOSTR_PRIVKEY or `git config nostr.privkey` (never argv)');
const priv = keyInput ? parsePrivateKey(keyInput) : Buffer.alloc(32, 1); // dry-run: throwaway key
log(`publishing as ${publicKey(priv).slice(0, 16)}…${keyInput ? '' : ' (dry-run throwaway key)'}`);

// ---- node + engine ----
const cli = [`${HOME}/bitcoin-knots/src/build/bin/bitcoin-cli`, `-conf=${net.conf}`];
const rpc = (...a) => { const o = execFileSync(cli[0], [...cli.slice(1), ...a], { maxBuffer: 64 << 20 }).toString().trim(); try { return JSON.parse(o); } catch { return o; } };
const k = createKernel({ core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
  chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network: net.id, overlays: [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))] });
const headerAt = (h) => rpc('getblockheader', rpc('getblockhash', String(h)), 'false');
const chainAt = (h) => (h < 0 ? null : k.codec.decode('BlockHeader', headerAt(h)));

// ---- validate the tip window before signing: every header rule, fork rules included ----
function validatedWindow(tip) {
  const startHeight = tip - HEADERS_COUNT + 1;
  const hexes = Array.from({ length: HEADERS_COUNT }, (_, i) => headerAt(startHeight + i));
  const headers = hexes.map((h) => k.codec.decode('BlockHeader', h));
  const prevContext = Array.from({ length: 11 }, (_, i) => chainAt(startHeight - 11 + i)).filter(Boolean);
  const res = k.headers.validateChain(headers, { startHeight, prevContext, now: Math.floor(Date.now() / 1000), chainAt });
  const failures = res.flatMap((r) => r.results.filter((x) => x.ok === false).map((x) => `${r.height}:${x.label}:${x.error}`));
  return { hexes, headers, res, failures, startHeight };
}

const relays = opt('relays')?.split(',').map((s) => s.trim()) ?? DEFAULT_RELAYS;
const uTags = opts('u').map((u) => u.split(','));
const pool = flag('dry-run') ? null : new RelayPool(relays, { log });
if (pool && await pool.connect() === 0) fail('no relays reachable');

let lastPublished = -1, unacked = 0;
async function tick() {
  const tip = rpc('getblockcount');
  if (tip === lastPublished) return;
  const w = validatedWindow(tip);
  if (w.failures.length) { log(`NOT publishing tip ${tip}: ${w.failures.join(' ')}`); return; }
  const event = buildHeadersEvent({ network: net.wire, headersHex: w.hexes, tip, uTags }, priv);
  const passed = w.res.reduce((n, r) => n + r.results.filter((x) => x.ok === true).length, 0);
  if (flag('dry-run')) {
    console.log(JSON.stringify({ id: event.id, pubkey: event.pubkey, kind: event.kind, tags: event.tags, content_bytes: event.content.length / 2, headers: HEADERS_COUNT, header_bytes: 164, tip, start: w.startHeight, rules_passed: passed }, null, 1));
    console.log(`  window ${w.startHeight}..${tip}: ${w.hexes.map((h, i) => `${w.startHeight + i}:${k.codec.blockHash(w.headers[i]).slice(0, 12)}`).join(' ')}`);
    lastPublished = tip; return;
  }
  const acks = await pool.publish(event);
  if (acks > 0) { lastPublished = tip; unacked = 0; log(`published tip ${tip} (${event.id.slice(0, 12)}…, ${passed} rules passed) — ${acks}/${relays.length} relays acked`); }
  else if (++unacked >= 5) fail('5 consecutive unacked publishes', 3);
  else log(`publish NOT acked (${unacked} consecutive)`);
}

await tick();
if (flag('once')) { pool?.close(); process.exit(0); }
setInterval(() => tick().catch((e) => log(`error: ${e.message}`)), net.poll * 1000);
