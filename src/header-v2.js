// Bitcoin Knots BLAKE2b hardfork (knots#359 / #385): block header v2.
//
// Wire layout (164 bytes). The first 80 bytes are the classic header with the
// top bit of `version` set; the remaining 84 bytes are new:
//   u32  version | 0x80000000
//   32   prevBlockHash            (internal/LE order, as always)
//   32   merkleRoot
//   u32  timeOnWire               (= time - timeOffset when flags & 4)
//   u32  bits
//   u32  nonce
//   u32  nonce2
//   u32  nonce3
//   16   extranonce               (uint128, internal order)
//   u32  timeOffset
//   u16  txCount                  (commits to the tx count; fixes CVE-2017-12842)
//   u8   flags                    (bits 0-1: ASIC profile, bit 2: use time offset; top 2 bits must be 0)
//   u8   xorKeyMaskClearBits
//   16   xorKey                   (uint128, internal order)
//   i32  height
//   32   mmRhs                    (merge-mining hook, reserved)
//
// Hash pipeline (primitives/block.cpp, CBlockHeader::GetHash), all SHA256
// tagged hashes are Core's TaggedHash(tag) = SHA256(SHA256(tag)||SHA256(tag)||msg):
//   xorKeyHash = T("Bitcoin block hash PoW XOR key")  << xorKey
//   mask       = T("Bitcoin block hash PoW XOR mask") << xorKey, low `clearBits` bits zeroed (0 if key null)
//   prevHidden = T("Bitcoin prevblock header, hashed") << prevHash(display order)
//   h1 = T("Bitcoin block header 1") << ver, prev(display), height, merkle, timeOnWire, 0u8, bits, u32 txCount, flags, clearBits, xorKeyHash
//   h2 = T("Merge-mining hook") << h1, 16 zero, 16 zero, mmRhs
//   b1 = blake2b_256( u32 0 || h2 || extranonce )
//   b2 = blake2b_256( profile-dependent layout of prevHidden/h2/nonces/timeOffset/b1 )
//   blockHash (display hex) = b2 XOR mask
// This file is deliberately standalone so it can be dropped into the
// bitcoin-kernel engine's Codec.blockHash / checkProofOfWork with no other deps.

import { taggedHash } from './sha256.js';
import { blake2b } from './blake2b.js';

export const HEADER_V2_SIZE = 164;
export const VERSION_HEADER_V2_FLAG = 0x80000000;
export const FLAG_USE_TIME_OFFSET = 4;

export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const hexToBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const rev = (b) => Uint8Array.from(b).reverse();
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const isZero = (b) => b.every((x) => x === 0);

export function isHeaderV2(bytes) { return bytes.length >= 4 && (bytes[3] & 0x80) !== 0; }

// Decode 164 wire bytes into a plain object. Hashes are display-order hex
// (as printed by bitcoind), same convention as bitcoin-kernel's Codec.
export function decodeHeaderV2(bytes) {
  if (bytes.length !== HEADER_V2_SIZE) throw new Error(`header v2 must be ${HEADER_V2_SIZE} bytes, got ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wireVersion = dv.getUint32(0, true);
  if (!(wireVersion & VERSION_HEADER_V2_FLAG)) throw new Error('not a v2 header (version top bit clear)');
  const h = {
    version: (wireVersion & ~VERSION_HEADER_V2_FLAG) | 0,
    prevBlockHash: bytesToHex(rev(bytes.subarray(4, 36))),
    merkleRoot: bytesToHex(rev(bytes.subarray(36, 68))),
    timeOnWire: dv.getUint32(68, true),
    bits: dv.getUint32(72, true),
    nonce: dv.getUint32(76, true),
    nonce2: dv.getUint32(80, true),
    nonce3: dv.getUint32(84, true),
    extranonce: bytesToHex(rev(bytes.subarray(88, 104))),
    timeOffset: dv.getUint32(104, true),
    txCount: dv.getUint16(108, true),
    flags: bytes[110],
    xorKeyMaskClearBits: bytes[111],
    xorKey: bytesToHex(rev(bytes.subarray(112, 128))),
    height: dv.getInt32(128, true),
    mmRhs: bytesToHex(rev(bytes.subarray(132, 164))),
  };
  h.time = (h.flags & FLAG_USE_TIME_OFFSET) ? (h.timeOnWire + h.timeOffset) >>> 0 : h.timeOnWire;
  return h;
}

export function encodeHeaderV2(h) {
  const timeOnWire = (h.flags & FLAG_USE_TIME_OFFSET) ? (h.time - h.timeOffset) >>> 0 : h.time >>> 0;
  return cat(
    u32(VERSION_HEADER_V2_FLAG | (h.version & ~VERSION_HEADER_V2_FLAG)),
    rev(hexToBytes(h.prevBlockHash)), rev(hexToBytes(h.merkleRoot)),
    u32(timeOnWire), u32(h.bits), u32(h.nonce), u32(h.nonce2), u32(h.nonce3),
    rev(hexToBytes(h.extranonce)), u32(h.timeOffset),
    Uint8Array.of(h.txCount & 0xff, (h.txCount >> 8) & 0xff, h.flags, h.xorKeyMaskClearBits),
    rev(hexToBytes(h.xorKey)), u32(h.height), rev(hexToBytes(h.mmRhs)),
  );
}

// Full hash pipeline; returns every intermediate so it can be checked against
// Knots' src/test/data/block_header_v2.json.
export function hashHeaderV2Detailed(h) {
  const timeOnWire = (h.flags & FLAG_USE_TIME_OFFSET) ? (h.time - h.timeOffset) >>> 0 : h.time >>> 0;
  const xorKeyWire = rev(hexToBytes(h.xorKey));            // uint128 internal order
  const prevDisplay = hexToBytes(h.prevBlockHash);         // hashPrevBlock.ReversedBytes()
  const xorKeyHash = taggedHash('Bitcoin block hash PoW XOR key', xorKeyWire);

  const mask = new Uint8Array(32);
  if (!isZero(xorKeyWire)) {
    mask.set(taggedHash('Bitcoin block hash PoW XOR mask', xorKeyWire));
    const clearBytes = h.xorKeyMaskClearBits >> 3;
    mask.fill(0, 0, clearBytes);
    if (clearBytes < 32) mask[clearBytes] &= 0xff >> (h.xorKeyMaskClearBits & 7);
  }

  const prevHidden = taggedHash('Bitcoin prevblock header, hashed', prevDisplay);

  const h1 = taggedHash('Bitcoin block header 1', cat(
    u32(VERSION_HEADER_V2_FLAG | (h.version & ~VERSION_HEADER_V2_FLAG)),
    prevDisplay, u32(h.height), rev(hexToBytes(h.merkleRoot)), u32(timeOnWire),
    Uint8Array.of(0), u32(h.bits), u32(h.txCount), Uint8Array.of(h.flags, h.xorKeyMaskClearBits), xorKeyHash,
  ));
  const zeros16 = new Uint8Array(16);
  const h2 = taggedHash('Merge-mining hook', cat(h1, zeros16, zeros16, rev(hexToBytes(h.mmRhs))));

  const b1 = blake2b(cat(u32(0), h2, rev(hexToBytes(h.extranonce))), 32);

  let asicInput;
  const nonces = [u32(h.nonce), u32(h.nonce2), u32(h.timeOffset), u32(h.nonce3)];
  switch (h.flags & 3) {
    case 0: { const p = Uint8Array.from(prevHidden); p.fill(0, 0, 6); asicInput = cat(p, ...nonces, b1); break; }
    case 1: asicInput = cat(u32(h.nonce), u32(h.nonce2), u32(h.nonce3), u32(h.timeOffset), b1, h2); break;
    case 2: asicInput = cat(new Uint8Array(48), h2, ...nonces, b1); break;
    case 3: asicInput = cat(new Uint8Array(80), h2, ...nonces, b1); break;
  }
  const b2 = blake2b(asicInput, 32);
  const hash = b2.map((x, i) => x ^ mask[i]); // display-order bytes: block.cpp reverses into internal order

  return {
    xorKeyHash: bytesToHex(xorKeyHash), h1: bytesToHex(h1), h2: bytesToHex(h2),
    blake2b1: bytesToHex(b1), blake2b2: bytesToHex(b2), mask: bytesToHex(mask),
    asicProfile: h.flags & 3, asicInput: bytesToHex(asicInput), blockHash: bytesToHex(hash),
  };
}

export const hashHeaderV2 = (h) => hashHeaderV2Detailed(h).blockHash;

export function expandCompact(bits) {
  const exponent = bits >>> 24, mantissa = BigInt(bits & 0x007fffff);
  return exponent <= 3 ? mantissa >> (8n * BigInt(3 - exponent)) : mantissa << (8n * BigInt(exponent - 3));
}
export const checkProofOfWorkV2 = (h) => BigInt('0x' + hashHeaderV2(h)) <= expandCompact(h.bits);
