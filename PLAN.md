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

## The hard part is data, not code

There is no public esplora / explorer / NIP-333 feed for the BLAKE2b chain yet, and NIP-333
assumes 80-byte headers. So the "health"-style page can't be pointed at mempool.space.
Blocks are light (≤ 300 kB, few txs) and the interesting chain is only ~2,600 blocks old,
so a static, epoch-sized export fits GitHub Pages:

- **anchor**: hard-code the fork epoch start (961,632) — its 8 SHA256d headers plus the
  fork block — as the light client's "genesis". Prior history is checkpointed away exactly like
  assumeUTXO does; a user who wants more can sync the SHA256d headers with the existing engine.
- **epochs**: `epochs/477.headers.bin` (2016 × 164 B ≈ 330 kB), `epochs/477.blocks/<height>.hex`
  (or one concatenated file with an offset index). One epoch at a time is a browser-friendly
  unit: headers verify in milliseconds, blocks validate in a Worker while the UI stays live.
- **producer**: a Knots 29.4.1 node (`getblockheader`/`getblock … 0`) → a tiny Node script that
  writes the epoch files. Testnet4 (fork at 150,308, ~11 GB chain) is the cheap dry run;
  mainnet needs IBD to 961,640 (use assumeUTXO 880,000 to shortcut) or a friend's node.
- **live tip**: later. Options: extend the NIP-333 publisher with a `d=btc-blake2b` tag carrying
  164-byte headers, or a WS→TCP bridge like browser-node act ⑤.

## Baby steps

1. ✅ `src/blake2b.js`, `src/sha256.js` (+ taggedHash), `src/header-v2.js`; `npm test` green
   against Knots' `block_header_v2.json`.
2. Vendor the bitcoin-kernel `engine/` (AGPL) and patch `Codec.decode/encode('BlockHeader')`,
   `blockHash`, `checkProofOfWork` to dispatch on the version top bit. Re-run the upstream
   test suite to prove SHA256d behaviour is untouched.
3. Add `btc:mainnet-blake2b` / `btc:testnet4-blake2b` to `chain.jsonld` (fork height, shift,
   RDTS expiry, headline, anchor headers) and the three header rules + three block rules.
4. `tools/export-epoch.mjs`: RPC → `epochs/<n>.headers.bin` + block files. Run on testnet4 first.
5. `index.html`: load anchor, load epoch, verify headers (PoW, link, height, difficulty incl.
   the shift), then validate blocks in a Worker (structure, merkle, txCount, weight cap,
   witness commitment, headline) — the health page minus esplora, plus the fork rules.
6. Live tip feed; RDTS/unified-sighash script rules; prevout-resolving validation (SwiftSync-style).

## References

- Knots PR 359 (hardfork), 358 (RDTS flag day), 385 (mainnet/testnet4 params); tag `v29.4.1.knots20260508`
- `src/primitives/block.{h,cpp}`, `src/pow.cpp`, `src/consensus/params.h`, `src/kernel/chainparams.cpp`,
  `src/validation.cpp` (CheckBlockHeader / CheckBlock / ContextualCheckBlock), `src/test/data/block_header_v2.json`
- https://btc-blake2b.org/developers, https://bitcoinknots.org/learn/2026-blake2b
- https://github.com/bitcoin-kernel/kernel, https://github.com/bitcoin-kernel/health
