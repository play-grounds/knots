# knots-kernel

Browser-side validation for the Bitcoin Knots BLAKE2b hardfork chain, built on the
[bitcoin-kernel](https://bitcoin-kernel.com/) pure-JS consensus engine. See [PLAN.md](PLAN.md).

Step 1 is done: a zero-dependency BLAKE2b-256, Core's tagged SHA256, and the 164-byte
header v2 codec + hash pipeline, verified against Bitcoin Knots' own test vectors.

```sh
npm test                       # Knots test vectors
node tools/check-live.mjs      # real headers from mempool.guide: fork block + tip
```

```js
import { decodeHeaderV2, hashHeaderV2, checkProofOfWorkV2 } from './src/header-v2.js';
const h = decodeHeaderV2(bytes164);   // fields incl. height, txCount, flags
hashHeaderV2(h);                       // display-order block hash hex
checkProofOfWorkV2(h);                 // hash <= target(bits)
```

`test/vectors/block_header_v2.json` is copied from Bitcoin Knots (MIT).
