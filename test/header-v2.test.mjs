// Checks src/ against Bitcoin Knots' own vectors (src/test/data/block_header_v2.json)
// and the pure-JS BLAKE2b against Node's blake2b512 for the 64-byte case.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { blake2b } from '../src/blake2b.js';
import { sha256 } from '../src/sha256.js';
import { decodeHeaderV2, encodeHeaderV2, hashHeaderV2Detailed, hexToBytes, bytesToHex, HEADER_V2_SIZE } from '../src/header-v2.js';

let n = 0;
const ok = (msg) => { n++; console.log('  ok', msg); };

// 1. primitives vs node:crypto
for (const len of [0, 1, 55, 64, 127, 128, 129, 300, 1000]) {
  const data = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff);
  assert.equal(bytesToHex(sha256(data)), createHash('sha256').update(data).digest('hex'));
  assert.equal(bytesToHex(blake2b(data, 64)), createHash('blake2b512').update(data).digest('hex'));
}
ok('sha256 and blake2b-512 match node:crypto');
// RFC 7693 appendix A: blake2b-512("abc")
assert.equal(bytesToHex(blake2b(new TextEncoder().encode('abc'), 64)).slice(0, 16), 'ba80a53f981c4d0d');
// blake2b-256("") = 0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8
assert.equal(bytesToHex(blake2b(new Uint8Array(0), 32)), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
ok('blake2b-256 (32-byte digest, distinct IV) matches known answer');

// 2. Knots header v2 vectors
const vectors = JSON.parse(readFileSync(new URL('./vectors/block_header_v2.json', import.meta.url))).headers;
for (const t of vectors) {
  const f = t.fields;
  const h = {
    version: f.nVersion, prevBlockHash: f.hashPrevBlock, merkleRoot: f.hashMerkleRoot, time: f.nTime, bits: f.nBits,
    nonce: f.nNonce, nonce2: f.m_nonce2, nonce3: f.m_nonce3, extranonce: f.m_extranonce, timeOffset: f.m_time_offset,
    txCount: f.m_txcount, flags: f.m_flags, xorKeyMaskClearBits: f.m_xor_key_mask_clear_bits, xorKey: f.m_xor_key,
    height: f.m_height, mmRhs: f.m_mm_rhs,
  };
  const enc = encodeHeaderV2(h);
  assert.equal(enc.length, HEADER_V2_SIZE, `${t.name}: size`);
  assert.equal(bytesToHex(enc), t.serialized, `${t.name}: serialized`);
  const dec = decodeHeaderV2(hexToBytes(t.serialized));
  assert.equal(dec.time, f.nTime, `${t.name}: time round-trip`);
  assert.equal(bytesToHex(encodeHeaderV2(dec)), t.serialized, `${t.name}: decode/encode round-trip`);
  const d = hashHeaderV2Detailed(h);
  assert.equal(d.xorKeyHash, t.xor_key_hash, `${t.name}: xor_key_hash`);
  assert.equal(d.h1, t.h1, `${t.name}: h1`);
  assert.equal(d.h2, t.h2, `${t.name}: h2`);
  assert.equal(d.blake2b1, t.blake2b_1, `${t.name}: blake2b_1`);
  assert.equal(d.asicProfile, t.asic_profile, `${t.name}: profile`);
  assert.equal(d.asicInput, t.asic_input, `${t.name}: asic_input`);
  assert.equal(d.blake2b2, t.blake2b_2, `${t.name}: blake2b_2`);
  assert.equal(d.mask, t.mask, `${t.name}: mask`);
  assert.equal(d.blockHash, t.block_hash, `${t.name}: block_hash`);
  assert.equal(hashHeaderV2Detailed(dec).blockHash, t.block_hash, `${t.name}: hash of decoded`);
  ok(`vector ${t.name} -> ${t.block_hash.slice(0, 16)}…`);
}
console.log(`\n${n} checks passed`);
