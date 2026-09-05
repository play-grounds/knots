// pm2 process definitions for the BLAKE2b-chain NIP-333 publishers.
// Same pattern as bitcoin-desktop/headers: the signing key is read from
// `git config nostr.privkey` (local to this repo) at load time and injected
// into the child's env — never argv, never this file.
//
//   pm2 start ecosystem.config.cjs            # both streams
//   pm2 start ecosystem.config.cjs --only nip333-tbtc4b2
//   pm2 logs nip333-tbtc4b2
const { execSync } = require('node:child_process');
const NOSTR_PRIVKEY = execSync('git config nostr.privkey', { cwd: __dirname }).toString().trim();
if (!/^([0-9a-fA-F]{64}|nsec1[a-z0-9]+)$/.test(NOSTR_PRIVKEY)) throw new Error('git config nostr.privkey is not set');
const app = (name, network) => ({
  name, script: 'tools/publish-nip333.mjs', args: network, cwd: __dirname,
  env: { NOSTR_PRIVKEY }, autorestart: true, restart_delay: 5000, max_restarts: 50, min_uptime: 20000, time: true,
});
module.exports = { apps: [app('nip333-tbtc4b2', 'testnet4'), app('nip333-btcb2', 'mainnet')] };
