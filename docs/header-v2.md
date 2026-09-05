# The 164-byte header, and what "time offset" means

Blocks on the Bitcoin Knots BLAKE2b chains (mainnet from height 961,640, testnet4 from
150,308) carry a 164-byte "v2" header instead of the classic 80-byte one. This page
explains the layout, the `flags` byte, and the note the
[headers page](../headers.html) prints when a block uses the time offset.

## Layout

The first 80 bytes keep the classic order, so old tools can still read the prefix.
Version bit 31 (0x80000000) marks a v2 header. The remaining 84 bytes follow.

| offset | size | field | notes |
|---:|---:|---|---|
| 0 | 4 | version | bit 31 set = v2; the low bits carry the usual version |
| 4 | 32 | prevBlockHash | |
| 36 | 32 | merkleRoot | |
| 68 | 4 | timeOnWire | the time as serialized (see below) |
| 72 | 4 | bits | |
| 76 | 4 | nonce | |
| 80 | 4 | nonce2 | extra nonce space |
| 84 | 4 | nonce3 | extra nonce space |
| 88 | 16 | extranonce | Stratum v1 extranonce, wire order |
| 104 | 4 | timeOffset | added to timeOnWire when flags bit 2 is set |
| 108 | 2 | txCount | must equal the number of transactions in the block |
| 110 | 1 | flags | see below |
| 111 | 1 | xorKeyMaskClearBits | proof-of-work mask parameter |
| 112 | 16 | xorKey | proof-of-work XOR key, wire order |
| 128 | 4 | height | must equal the parent's height + 1 |
| 132 | 32 | mmRhs | merge-mining hook, all zeros so far |

The block hash is not SHA256d of these bytes. It is a tagged-SHA256 commitment tree over
the fields, hashed twice with BLAKE2b-256 in an ASIC-friendly layout, then masked with
`xorKey`. The [schema overlay](https://github.com/bitcoin-desktop/schema/blob/gh-pages/codec/pow/knots-header-v2.js)
implements it and is checked against the Knots test vectors.

## The flags byte

| bit | value | meaning |
|---:|---:|---|
| 0-1 | 1, 2 | ASIC layout profile (which order the nonces are hashed in) |
| 2 | 4 | **use time offset**: the block time is `timeOnWire + timeOffset` |
| 3-5 | 8-32 | unused |
| 6-7 | 64, 128 | reserved for future hardforks; a header with either set is invalid (`bad-flags-highbits`) |

## Time offset

Every v2 header carries a 4-byte `timeOffset`, and it sits with the nonces in the layout
that the ASIC hashes. That gives mining hardware another 32 bits to roll without new work
from the pool. What the rolled value means depends on flags bit 2:

- **bit 2 clear**: `timeOffset` is ignored for consensus. It is pure extra nonce space.
  The block time is `timeOnWire`.
- **bit 2 set**: the block time is `timeOnWire + timeOffset` (wrapping 32-bit add). Rolling
  the offset moves the block's timestamp, so hardware can "roll nTime" the way SHA256d
  miners do today, and the wire time stays as the pool issued it.

Everything that depends on the block time (median-time-past, the 2-hour future limit,
retargeting, the testnet4 20-minute rule, locktimes) uses the consensus time, i.e. the
sum. Knots' RPC reports that sum as `time` and exposes the raw fields as
`time_offset` and `header_flags`.

### Example: mainnet block 967,908

The headers page notes "time offset" on this block. The decoded header:

| field | value |
|---|---:|
| header_flags | 4 (bit 2 set) |
| timeOffset | 0 |
| timeOnWire | 1788609766 |
| consensus time | 1788609766 |

The miner's software set the flag but never rolled the offset, so the block time is
unchanged. The neighbouring block 967,907 has flags 0. Both validate.

## What the page shows

The notes column prints "time offset" whenever flags bit 2 is set, with the offset value in
seconds when it is non-zero. The `time` column is always the consensus time, the same value
the node reports.

Source: Knots `src/primitives/block.h` (`BlockHeaderFlag::UseTimeOffset`, `GetTimeOnWire`)
and `src/validation.cpp` (`CheckBlockHeader`), release 29.4.1.knots20260508.
