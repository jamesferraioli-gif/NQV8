// api/equity-complete.js
// Called when a founder submits their review after approving work.
// Calls completeReservation() on V4 from the Operations wallet,
// splitting 3.5% to the platform and 96.5% to the builder.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const PLATFORM_WALLET         = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';
const PLATFORM_FEE_BPS        = 350; // 3.5%
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function completeReservation(bytes32 companyId, bytes32 bountyId, address platformWallet, uint256 feeBps) external",
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

    const { companyId, bountyId } = req.body;

    if (!companyId || !bountyId) {
        return res.status(400).json({ error: 'Missing companyId or bountyId' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity   = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, wallet);

        const companyIdBytes = toBytes32(companyId);
        const bountyIdBytes  = toBytes32(bountyId);

        // Verify reservation exists and is active
        const reservation = await equity.reservations(companyIdBytes, bountyIdBytes);
        if (!reservation.active) {
            return res.status(400).json({ error: 'No active reservation found for this bounty' });
        }

        const totalUnits    = reservation.units.toNumber();
        const platformUnits = Math.floor(totalUnits * PLATFORM_FEE_BPS / 10000);
        const workerUnits   = totalUnits - platformUnits;

        const tx = await equity.completeReservation(companyIdBytes, bountyIdBytes, PLATFORM_WALLET, PLATFORM_FEE_BPS);
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
        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('gas required exceeds allowance') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        } else if (e.message.includes('No active reservation')) {
            userMessage = 'No active equity reservation found for this bounty.';
        } else if (e.message.includes('Company equity paused')) {
            userMessage = 'This company\'s equity is currently paused. Please contact NQVate support.';
        }
        return res.status(500).json({ error: userMessage });
    }
}
