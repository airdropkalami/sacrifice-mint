#!/usr/bin/env node
// Plan + simulate a ×N mint of an OpenSea SeaDrop PUBLIC sale.   Read-only, zero dependencies, never signs.
//   node scripts/plan.mjs --rpc <url> --nft <0x…> --total <N> --factory <0x… SacrificeMinter> --from <your wallet>
// Output: the transaction(s) {to, data, value} for YOU to send from your own wallet, plus an eth_call simulation of
// each. Nothing here holds a key or sends anything.
//
// The plan is the cheapest one: if the per-wallet cap already covers N, one direct mint and no Minters at all;
// otherwise the fewest addresses — ceil(N / cap) — your own wallet mints the remainder directly and each Minter mints
// a full cap (one uniform calldata for all of them).

const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';     // SeaDrop 1.0 singleton (same address on every chain)
const SEL = { getPublicDrop: '0xbc6a629c', getAllowedFeeRecipients: '0x68632274', mintPublic: '0x161ac21f', batchMint: '0x61da17ef' };
const ZERO = '0x' + '00'.repeat(20);

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const addrOk = a => /^0x[0-9a-fA-F]{40}$/.test(a || '');
if (!args.rpc || !addrOk(args.nft) || !addrOk(args.factory) || !addrOk(args.from) || !(+args.total >= 1)) {
  console.log('usage: node scripts/plan.mjs --rpc <url> --nft <0x…> --total <N> --factory <0x…> --from <0x…>'); process.exit(1);
}
const total = Math.floor(+args.total);

async function rpc(method, params) {
  const r = await fetch(args.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
  return j.result;
}
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addrWord = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hex = n => '0x' + BigInt(n).toString(16);

export function planBatch({ total, maxPerWallet }) {
  const t = total, q = maxPerWallet || 0;
  if (q === 0 || t <= q) return { strategy: 'direct', directQty: t, minters: 0, perMinterQty: 0 };
  const minters = Math.ceil(t / q) - 1;
  return { strategy: 'sacrifice', directQty: t - minters * q, minters, perMinterQty: q };
}
// minterIfNotPayer = address(0): the CALLER is the minter, so each Minter takes its own per-wallet allowance
const mintPublic = (nft, feeRecipient, qty) => SEL.mintPublic + addrWord(nft) + addrWord(feeRecipient) + addrWord(ZERO) + word(qty);
function batchMint({ drop, mintData, perMint, nft, n }) {
  const d = mintData.replace(/^0x/, ''), len = d.length / 2, padded = d + '0'.repeat((64 - (d.length % 64)) % 64);
  return SEL.batchMint + addrWord(drop) + word(5 * 32) + word(perMint) + addrWord(nft) + word(n) + word(len) + padded;
}

// 1. the public sale, straight from the SeaDrop singleton (a non-SeaDrop token reads all zeros)
const pd = (await rpc('eth_call', [{ to: SEADROP, data: SEL.getPublicDrop + addrWord(args.nft) }, 'latest'])).replace(/^0x/, '');
const w = i => BigInt('0x' + pd.slice(i * 64, (i + 1) * 64));
const pub = { price: w(0), start: Number(w(1)), end: Number(w(2)), maxPerWallet: Number(w(3)) };
const fr = (await rpc('eth_call', [{ to: SEADROP, data: SEL.getAllowedFeeRecipients + addrWord(args.nft) }, 'latest'])).replace(/^0x/, '');
const feeRecipient = fr.length >= 192 && parseInt(fr.slice(64, 128), 16) > 0 ? '0x' + fr.slice(128 + 24, 192) : null;
const now = Math.floor(Date.now() / 1000);
const live = pub.end > now && pub.start <= now && pub.maxPerWallet > 0 && !!feeRecipient;
// getMintStats(minter) → (minterNumMinted, currentTotalSupply, maxSupply), the SeaDrop token interface
let supply = null;
try {
  const ms = (await rpc('eth_call', [{ to: args.nft, data: '0x840e15d4' + addrWord(args.from) }, 'latest'])).replace(/^0x/, '');
  if (ms.length >= 192) supply = { youMinted: Number(BigInt('0x' + ms.slice(0, 64))), minted: Number(BigInt('0x' + ms.slice(64, 128))), max: Number(BigInt('0x' + ms.slice(128, 192))) };
} catch { /* not every token exposes it */ }
const out = { nft: args.nft, publicSale: { priceWei: pub.price.toString(), start: pub.start, end: pub.end, maxPerWallet: pub.maxPerWallet, feeRecipient, live }, supply };
if (!live) { out.verdict = 'not an active SeaDrop public sale — ×N not possible (allowlist / not started / ended / not SeaDrop)'; console.log(JSON.stringify(out, null, 1)); process.exit(0); }
if (supply && supply.max > 0 && supply.minted + total > supply.max) {
  out.verdict = supply.minted >= supply.max ? `sold out (${supply.minted}/${supply.max})` : `only ${supply.max - supply.minted} left — ask for at most that many`;
  console.log(JSON.stringify(out, null, 1)); process.exit(0);
}
if (supply && supply.youMinted > 0) out.note = `your wallet already minted ${supply.youMinted}; the direct share can revert if that used up your cap`;

// 2. the cheapest plan
const plan = planBatch({ total, maxPerWallet: pub.maxPerWallet });
out.plan = plan;
const txs = [];
if (plan.minters > 0) {
  const perMint = pub.price * BigInt(plan.perMinterQty);
  txs.push({ label: `factory: ${plan.minters} Minter(s) × ${plan.perMinterQty}`, to: args.factory,
    data: batchMint({ drop: SEADROP, mintData: mintPublic(args.nft, feeRecipient, plan.perMinterQty), perMint, nft: args.nft, n: plan.minters }),
    value: hex(perMint * BigInt(plan.minters)) });
}
if (plan.directQty > 0) txs.push({ label: `direct: your wallet × ${plan.directQty}`, to: SEADROP, data: mintPublic(args.nft, feeRecipient, plan.directQty), value: hex(pub.price * BigInt(plan.directQty)) });

// 3. simulate each from YOUR address (eth_call: nothing is signed or sent). A revert here = do not send.
for (const tx of txs) {
  try {
    const gas = await rpc('eth_estimateGas', [{ from: args.from, to: tx.to, data: tx.data, value: tx.value }]);
    tx.simulation = { ok: true, gas: Number(BigInt(gas)) };
  } catch (e) { tx.simulation = { ok: false, error: String(e.message).slice(0, 200) }; }
}
out.transactions = txs;
out.next = txs.every(t => t.simulation.ok)
  ? 'Both simulations passed. Send each transaction from your own wallet (factory first), then check your NFT balance.'
  : 'A simulation reverted — do not send. Common causes: wallet balance too low, sale not live, the factory is not deployed on this chain.';
console.log(JSON.stringify(out, null, 1));
