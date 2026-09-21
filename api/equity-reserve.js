// api/equity-reserve.js
// Called when a founder accepts an equity bid.
// Calls reserveEquity() on V3 from the Operations wallet so the
// transaction goes directly to the contract without MetaMask interference.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0x99A3512b49b2dd8b4b553E98aAcF344DFF109C51';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function reserveEquity(string companyId, string bountyId, address beneficiary, uint256 units) external",
    "function availableBalance(string companyId, address holder) external view returns (uint256)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { companyId, bountyId, beneficiaryWallet, equityUnits, founderWallet } = req.body;

    if (!companyId || !bountyId || !beneficiaryWallet || !equityUnits) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity   = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, wallet);

        // Verify available balance
        if (founderWallet) {
            const available = await equity.availableBalance(companyId, founderWallet);
            if (available.lt(ethers.BigNumber.from(equityUnits))) {
                return res.status(400).json({
                    error: `Insufficient available equity. Founder has ${available.toNumber() / 100}% available.`
                });
            }
        }

        const tx = await equity.reserveEquity(companyId, bountyId, beneficiaryWallet, equityUnits);
        await tx.wait();

        console.log(`✅ Reserved ${equityUnits} units for bounty ${bountyId} → ${beneficiaryWallet}`);
        console.log(`   Tx: ${tx.hash}`);

        return res.status(200).json({ success: true, txHash: tx.hash, equityUnits });

    } catch(e) {
        console.error('equity-reserve error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
