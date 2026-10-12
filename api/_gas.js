// api/_gas.js
// Arbitrum One does not collect priority tips — the network runs at a 0.02 gwei
// floor and "Priority: 0 Gwei". But ethers v5 defaults maxPriorityFeePerGas to
// 1.5 gwei, so every ops-wallet transaction was paying ~1.52 gwei: roughly 76x
// the floor, buying nothing. Measured cost was ~$0.33/tx instead of ~$0.004.
//
// Spread these overrides into EVERY ops-signed contract call.

export async function gasOverrides(provider, bufferPct = 200) {
    try {
        const base = await provider.getGasPrice();               // ~0.02 gwei on Arbitrum
        // 3x the current price. Arbitrum's floor is adjustable between 0.01 and
        // 0.10 gwei without a DAO vote, and a tx priced under the floor hangs
        // pending forever. At these prices 3x costs ~$0.015 instead of ~$0.005 —
        // cheap insurance against a stuck ops transaction.
        return { gasPrice: base.mul(100 + bufferPct).div(100) };
    } catch (e) {
        console.warn('gasOverrides: falling back to node defaults —', e.message);
        return {};
    }
}
