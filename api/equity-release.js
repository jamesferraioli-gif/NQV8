// api/equity-release.js
// Called when a bounty is cancelled, deadline passes, or work is rejected.
// Calls releaseReservation() on V4 from the Operations wallet,
// returning the reserved units to the founder's available balance.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function releaseReservation(bytes32 companyId, bytes32 bountyId) external",
    "function reservations(bytes32 companyId, bytes32 bountyId) external view returns (address founder, address beneficiary, uint128 units, bool active)"
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

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

        const companyIdBytes = toBytes32(companyId);
        const bountyIdBytes  = toBytes32(bountyId);

        // Check if reservation is active
        const reservation = await equity.reservations(companyIdBytes, bountyIdBytes);
        if (!reservation.active) {
            return res.status(200).json({
                success: true,
                skipped: true,
                reason: 'No active reservation found — already released or never existed'
            });
        }

        const units = reservation.units.toNumber();
        const tx = await equity.releaseReservation(companyIdBytes, bountyIdBytes);
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
        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('gas required exceeds allowance') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        }
        return res.status(500).json({ error: userMessage });
    }
}
