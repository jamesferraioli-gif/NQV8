// api/equity-complete.js
// Called when a founder submits their review after approving work.
// Calls completeReservation() on V3 from the Operations wallet,
// splitting 3.5% to the platform and 96.5% to the builder.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0x99A3512b49b2dd8b4b553E98aAcF344DFF109C51';
const PLATFORM_WALLET         = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';
const PLATFORM_FEE_BPS        = 350; // 3.5%
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function completeReservation(string companyId, string bountyId, address platformWallet, uint256 feeBps) external",
    "function reservations(string companyId, string bountyId) external view returns (address,address,uint256,bool)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { companyId, bountyId } = req.body;

    if (!companyId || !bountyId) {
        return res.status(400).json({ error: 'Missing companyId or bountyId' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity   = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, wallet);

        // Verify reservation exists and is active
        const res2 = await equity.reservations(companyId, bountyId);
        if (!res2[3]) {
            return res.status(400).json({ error: 'No active reservation found for this bounty' });
        }

        const totalUnits    = res2[2].toNumber();
        const platformUnits = Math.round(totalUnits * PLATFORM_FEE_BPS / 10000);
        const workerUnits   = totalUnits - platformUnits;

        const tx = await equity.completeReservation(companyId, bountyId, PLATFORM_WALLET, PLATFORM_FEE_BPS);
        await tx.wait();

        console.log(`✅ Completed reservation for bounty ${bountyId}`);
        console.log(`   Worker: ${workerUnits} units, Platform: ${platformUnits} units`);
        console.log(`   Tx: ${tx.hash}`);

        return res.status(200).json({
            success: true,
            txHash: tx.hash,
            totalUnits,
            workerUnits,
            platformUnits
        });

    } catch(e) {
        console.error('equity-complete error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
