// api/_bonds.js
//
// Slashing a builder's engagement bond. One place, because the two callers —
// a dispute ruling and a missed deadline — must not drift apart on policy.
//
// WHO DECIDES: not the model. The arbitration prompt returns a split of the
// escrowed funds and nothing else; the slash is a deterministic function of
// that number, computed here. Asking an LLM "how much of their collateral
// should be destroyed" would put a second, unconstrained money decision
// behind a prompt that parties to the dispute can write into.
//
// WHERE IT GOES: burned, not paid to the founder.
//
// The instinct is to compensate the wronged party, and the contract supports
// it. But escrow already makes the founder whole — a ruling against the
// builder returns their USDC — so the residual loss is time, which has no
// honest figure. Paying it out of the bond would mean a founder profits from
// a dispute they win, which is an incentive to file them. Burning means
// nobody gains from a slash, so nobody has a reason to manufacture one. The
// beneficiary path stays available in the contract for a case where real,
// demonstrable loss exists.

import { ethers } from 'ethers';

export const STAKING_ADDRESS = '0x5d430f7Faae867E0A8a02EcCcbE21eF40628937c';
export const BOND_KIND_BID   = 1;

const STAKING_ABI = [
    "function slashBond(bytes32 bondId, address beneficiary, uint16 totalBps, uint16 beneficiaryBps, string reason) external",
    "function getBond(bytes32 bondId) external view returns (tuple(address holder, uint256 amount, bytes32 ref, uint8 kind, uint8 status, uint64 createdAt, uint64 expiresAt, uint256 creditOnRelease))",
    "function releaseBond(bytes32 bondId) external"
];

/// Must match bidBondId() in index.html and the bond endpoints.
export function bidBondId(projectId, holder) {
    return ethers.utils.solidityKeccak256(
        ['string', 'address', 'uint8'], [projectId, holder, BOND_KIND_BID]);
}

/**
 * How much of the bond a ruling forfeits, in basis points.
 *
 * Graduated rather than all-or-nothing, so a builder who delivered most of
 * the work does not lose the same collateral as one who delivered none. The
 * bond is a penalty ON TOP of not being paid, so it does not need to carry
 * the whole deterrent by itself.
 */
export function slashBpsForRuling(workerPct) {
    const p = Number(workerPct);
    if (!Number.isFinite(p)) return 0;
    if (p >= 75) return 0;       // substantially delivered — nothing forfeited
    if (p >= 50) return 2500;    // real gaps
    if (p >= 25) return 5000;    // substantially incomplete
    return 10000;                // nothing of value delivered
}

/**
 * Apply an outcome to a builder's bond: slash part of it, or release it.
 *
 * Never throws. A bond is secondary to the money it sits behind — a dispute
 * ruling that moved USDC and equity on-chain must not be reported as failed
 * because a slash reverted afterwards. Callers log the returned result.
 */
export async function settleEngagementBond({
    provider, signer, projectId, bondWallet, slashBps, reason
}) {
    try {
        if (!bondWallet || !ethers.utils.isAddress(bondWallet)) {
            return { ok: false, skipped: 'no bond wallet recorded on the accepted bid' };
        }

        const staking = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer);
        const bondId  = bidBondId(projectId, bondWallet.toLowerCase());
        const bond    = await staking.getBond(bondId);

        // 0 None · 1 Active · 2 Released · 3 Slashed
        if (bond.status !== 1) {
            return { ok: false, skipped: `bond is not active (status ${bond.status})`, bondId };
        }

        const bps = Math.max(0, Math.min(10000, Math.round(slashBps || 0)));

        if (bps === 0) {
            const tx = await staking.releaseBond(bondId);
            const r  = await tx.wait();
            if (!r || r.status === 0) throw new Error('releaseBond reverted');
            return { ok: true, action: 'released', bondId, txHash: tx.hash,
                     amount: ethers.utils.formatUnits(bond.amount, 18) };
        }

        // beneficiaryBps 0 — the whole slashed portion is burned. See the
        // header for why this is not paid to the counterparty.
        const tx = await staking.slashBond(
            bondId, ethers.constants.AddressZero, bps, 0, String(reason || '').slice(0, 200));
        const r = await tx.wait();
        if (!r || r.status === 0) throw new Error('slashBond reverted');

        const slashed = bond.amount.mul(bps).div(10000);
        return {
            ok: true, action: 'slashed', bondId, bps, txHash: tx.hash,
            burned:   ethers.utils.formatUnits(slashed, 18),
            returned: ethers.utils.formatUnits(bond.amount.sub(slashed), 18)
        };

    } catch (e) {
        console.error('settleEngagementBond failed:', e.message);
        return { ok: false, error: e.message };
    }
}

/// The wallet a project's bond is held against. Recorded on the accepted bid
/// at bid time; older bounties predate bonds and have none.
export function bondWalletFor(project) {
    const b = project && (project.acceptedBid || {});
    return b.bondWallet || null;
}
