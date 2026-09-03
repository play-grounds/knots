# knots-kernel — plan

Goal: a browser-resident validator for the Bitcoin Knots BLAKE2b chain, built on the
[bitcoin-kernel](https://bitcoin-kernel.com/) pure-JS engine, in the style of
[bitcoin-kernel.com/health](https://bitcoin-kernel.com/health/) (static page, no backend,
headers self-certified in the tab, blocks fetched and re-validated in a Worker).

## What the fork actually is (from `bitcoinknots/bitcoin` tag `v29.4.1.knots20260508`)

Not a new genesis. The chain keeps Bitcoin's history and hard-forks at a height:

| param | mainnet | testnet4 |
|---|---|---|
| `Blake2bHeight` (first BLAKE2b block) | 961,640 | 150,308 |
| first BLAKE2b block hash | `0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb` | — |
| last SHA256d block | 961,639 (checkpointed) | — |
| `Blake2bTargetShift` (one-off target ease at fork block) | 2^22 | default 2^20 |
| RDTS window (800 kWU cap + reduced-data script rules) | from fork until parent MTP ≥ 2027-09-01 | until 2026-10-13 |
| required coinbase headline in fork block | `8-30 NYPost Deride And Conquer` | — |
| P2P magic / port / genesis / retarget interval | unchanged | unchanged |

Consensus changes that matter to a light validator, in the order the engine meets them:

1. **Header v2, 164 bytes** (`primitives/block.h`). Version top bit set. Adds nonce2, nonce3,
   128-bit extranonce, time offset, **tx count (u16)**, flags (ASIC profile + time-offset bit),
   XOR-key + mask-clear-bits, **height (i32)**, and a 32-byte merge-mining slot.
   Blocks at/after the fork height must be v2; before it must be v1. `header.height == prev.height+1`.
2. **Block hash** = SHA256 tagged-hash tree (h1 → h2) → BLAKE2b-256 → BLAKE2b-256 over a
   profile-dependent ASIC layout → XOR with a key-derived mask. See `src/header-v2.js`.
   PoW compare is unchanged: hash (as 256-bit BE number) ≤ target from `bits`.
3. **Difficulty**: identical 2016-block retarget with 4× clamp. Exactly one extra rule: at
   the fork block the computed target is shifted left by `Blake2bTargetShift` (clamped at powLimit).
   No BIP94 on mainnet, so the retarget bases on the last block's `bits`.
   The fork sits 8 blocks into epoch 477 (961,632–963,647): a retarget at 963,648 uses the
   SHA256d epoch-first time from 961,632.
4. **Block body**: `txCount` in header must equal `vtx.size()`; merkle root / txid / wtxid /
   witness commitment are **unchanged** (still SHA256d); block weight ≤ **800,000** while RDTS
   is active (MTP-based expiry); fork block's coinbase scriptSig must contain the headline.
5. **Scripts** (only needed for full validation with prevouts):
   `SCRIPT_VERIFY_REDUCED_DATA` bundle (BIP110 rules as consensus during the window, inputs
   spending pre-fork coins exempt) and opt-in `SIGHASH_UNIFIED` (hash-type bit 0x20, BIP341-shaped
   message, `doc/unified-sighash.md`). ~200 lines of `interpreter.cpp` diff.

Everything else in the engine (tx codec, merkle, SPV proofs, script interpreter for legacy /
segwit / taproot) applies as-is.

## How hard is it?

Small. The full Knots diff for the fork is ~1,200 lines in `src/`, most of it plumbing
(headerssync, net, RPC, miner). The consensus surface for a header/blocks light client is:

| piece | status | est. |
|---|---|---|
| BLAKE2b-256 pure JS | **done**, matches node:crypto + RFC | — |
| header v2 codec + hash pipeline | **done**, matches all 5 Knots vectors | — |
| engine: `Codec` BlockHeader v1/v2 switch on version top bit | todo | ~60 lines |
| engine: `HeaderEngine` fork-height rules (v2 required, height field, target shift, flags high bits) | todo | ~40 lines |
| engine: `BlockEngine` txCount, 800 kWU window, headline | todo | ~30 lines |
| chain params node for `btc:mainnet-blake2b` in `chain.jsonld` | todo | data only |
| RDTS script flags + unified sighash | later | ~300 lines, needs vectors from Knots QA |

## Data sources

**mempool.guide** runs a full esplora API on the BLAKE2b chain (verified 2026-09-03, tip 966,385):
`/api/blocks/tip/height`, `/api/block-height/<h>`, `/api/block/<hash>/header` returns the
**164-byte v2 header (328 hex)**, `/api/block/<hash>` JSON carries a `header_v2` object,
`/api/block/<hash>/raw` gives the full block. `tools/check-live.mjs` fetches real headers and
reproduces the explorer's block hash + PoW check with `src/header-v2.js` (fork block, 961,641,
first retarget block 963,648, tip: all match).

So the health page pattern carries over almost unchanged: swap mempool.space for mempool.guide,
teach the codec 164-byte headers, add the fork rules. Blocks are ~300 kB max and mostly tiny.

**Later — own NIP-333 feed.** NIP-333 assumes 80-byte headers, so the BLAKE2b chain needs a
new `d` tag (e.g. `btc-blake2b`) and 328-hex headers per entry. Publisher = a small script
polling mempool.guide (or a Knots node) and signing kind-33333 events. The page then takes the
tip from Nostr and gap-fills from esplora, exactly as health does today.

**Epoch files** (optional, for offline / GitHub-Pages-only): an anchor at the fork epoch start
(961,632, its 8 SHA256d headers + the fork block) and `epochs/<n>.headers.bin` (2016 x 164 B
~ 330 kB). Nice-to-have once the live path works.

## Baby steps

1. ✅ `src/blake2b.js`, `src/sha256.js` (+ taggedHash), `src/header-v2.js`; `npm test` green
   against Knots' `block_header_v2.json`; `tools/check-live.mjs` green against mempool.guide.
2. Vendor the bitcoin-kernel `engine/` (AGPL) and patch `Codec.decode/encode('BlockHeader')`,
   `blockHash`, `checkProofOfWork` to dispatch on the version top bit. Re-run the upstream
   test suite to prove SHA256d behaviour is untouched.
3. Add `btc:mainnet-blake2b` / `btc:testnet4-blake2b` to `chain.jsonld` (fork height, shift,
   RDTS expiry, headline, anchor headers) and the three header rules + three block rules.
4. `index.html`: fork of the health page pointed at mempool.guide — newest N headers, verify
   PoW / link / height / difficulty (incl. the shift), then validate blocks in a Worker
   (structure, merkle, txCount, 800 kWU cap, witness commitment, headline).
5. Own NIP-333 feed for the BLAKE2b chain (`d=btc-blake2b`, 164-byte headers) + page takes tip from Nostr.
6. Epoch files for offline use; RDTS/unified-sighash script rules; prevout-resolving validation.

## References

- Knots PR 359 (hardfork), 358 (RDTS flag day), 385 (mainnet/testnet4 params); tag `v29.4.1.knots20260508`
- `src/primitives/block.{h,cpp}`, `src/pow.cpp`, `src/consensus/params.h`, `src/kernel/chainparams.cpp`,
  `src/validation.cpp` (CheckBlockHeader / CheckBlock / ContextualCheckBlock), `src/test/data/block_header_v2.json`
- https://btc-blake2b.org/developers, https://bitcoinknots.org/learn/2026-blake2b
- https://github.com/bitcoin-kernel/kernel, https://github.com/bitcoin-kernel/health
