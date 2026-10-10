#!/usr/bin/env node
// Compatibility probe: can a sacrifice minter batch this NFT contract at all?   Read-only, zero dependencies.
//   node scripts/probe.mjs --rpc <https url> --nft <0x…>
//
// The two things that defeat the pattern are visible in bytecode:
//   • require(msg.sender == tx.origin)  → CALLER ORIGIN EQ (0x33 0x32 0x14) or ORIGIN CALLER EQ  → HARD NO
//   • tx.origin used anywhere (ORIGIN, 0x32) → the per-wallet limit MIGHT be keyed on it         → UNCERTAIN
// EXTCODESIZE / isContract checks are NOT a problem: a Minter does its work inside its own constructor, where its
// code length is still 0, so it looks like a wallet.
// This is a static heuristic. The definitive answer is the eth_call simulation in plan.mjs.

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
if (!args.rpc || !/^0x[0-9a-fA-F]{40}$/.test(args.nft || '')) { console.log('usage: node scripts/probe.mjs --rpc <url> --nft <0x…>'); process.exit(1); }

async function rpc(method, params) {
  const r = await fetch(args.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';   // EIP-1967
const MINIMAL_PROXY = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e/i;                    // EIP-1167

async function logicCode(addr) {
  let code = await rpc('eth_getCode', [addr, 'latest']);
  if (!code || code === '0x') return { code: null, via: null };
  const m = MINIMAL_PROXY.exec(code.slice(2));
  let impl = m ? '0x' + m[1] : null;
  if (!impl) { const s = await rpc('eth_getStorageAt', [addr, IMPL_SLOT, 'latest']).catch(() => null); if (s && /[1-9a-f]/i.test(s.slice(2))) impl = '0x' + s.slice(-40); }
  if (impl) { const c2 = await rpc('eth_getCode', [impl, 'latest']); if (c2 && c2 !== '0x') return { code: c2, via: impl }; }
  return { code, via: null };
}

/** Real opcodes only — PUSH immediates are skipped, or operand bytes would be read as instructions. */
function opcodes(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex'), ops = [];
  for (let i = 0; i < b.length; i++) { const op = b[i]; ops.push(op); if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; }
  return ops;
}

const { code, via } = await logicCode(args.nft);
if (!code) { console.log(JSON.stringify({ verdict: 'unknown', reason: 'no code at this address' })); process.exit(0); }
const ops = opcodes(code);
let origin = 0, guard = false, extcodesize = 0;
for (let i = 0; i < ops.length; i++) {
  if (ops[i] === 0x32) origin++;
  if (ops[i] === 0x3b) extcodesize++;
  if (i + 2 < ops.length && ops[i + 2] === 0x14 && ((ops[i] === 0x33 && ops[i + 1] === 0x32) || (ops[i] === 0x32 && ops[i + 1] === 0x33))) guard = true;
}
const verdict = guard ? 'incompatible' : origin ? 'uncertain' : 'compatible';
console.log(JSON.stringify({
  nft: args.nft, logicVia: via, codeBytes: (code.length - 2) / 2, verdict,
  why: guard ? 'msg.sender == tx.origin guard: any contract caller reverts'
    : origin ? `tx.origin used ${origin}× — the per-wallet limit may be keyed on it; confirm with plan.mjs simulation`
    : 'no tx.origin anywhere: per-wallet limit cannot be keyed on the origin wallet',
  extcodesizeChecks: extcodesize, note: 'EXTCODESIZE checks are bypassed by constructor-minting',
}, null, 1));
