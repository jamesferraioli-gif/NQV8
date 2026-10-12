// api/_gas.js
// Arbitrum One does not collect priority tips — the network runs at a 0.02 gwei
// floor and "Priority: 0 Gwei". But ethers v5 defaults maxPriorityFeePerGas to
// 1.5 gwei, so every ops-wallet transaction was paying ~1.52 gwei: roughly 76x
// the floor, buying nothing. Measured cost was ~$0.33/tx instead of ~$0.004.
//
// Spread these overrides into EVERY ops-signed contract call.

export async function gasOverrides(provider, bufferPct = 25) {
    try {
        const base = await provider.getGasPrice();              // ~0.02 gwei on Arbitrum
        return { gasPrice: base.mul(100 + bufferPct).div(100) }; // headroom if the floor moves
    } catch (e) {
        console.warn('gasOverrides: falling back to node defaults —', e.message);
        return {};
    }
}
