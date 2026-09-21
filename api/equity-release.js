// api/equity-release.js
// Called when a bounty is cancelled, deadline passes, or work is rejected.
// Calls releaseReservation() on V3 from the Operations wallet,
// returning the reserved units to the founder's available balance.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0x99A3512b49b2dd8b4b553E98aAcF344DFF109C51';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function releaseReservation(string companyId, string bountyId) external",
    "function reservations(string companyId, string bountyId) external view returns (address,address,uint256,bool)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { companyId, bountyId, reason } = req.body;

    if (!companyId || !bountyId) {
        return res.status(400).json({ error: 'Missing companyId or bountyId' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity   = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, wallet);

        // Check if reservation is active
        const reservation = await equity.reservations(companyId, bountyId);
        if (!reservation[3]) {
            return res.status(200).json({
                success: true,
                skipped: true,
                reason: 'No active reservation found — already released or never existed'
            });
        }

        const units = reservation[2].toNumber();
        const tx = await equity.releaseReservation(companyId, bountyId);
        await tx.wait();

        console.log(`✅ Released ${units} units for bounty ${bountyId}`);
        console.log(`   Reason: ${reason || 'Not specified'}`);
        console.log(`   Tx: ${tx.hash}`);

        return res.status(200).json({
            success: true,
            txHash: tx.hash,
            unitsReleased: units,
            reason
        });

    } catch(e) {
        console.error('equity-release error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
