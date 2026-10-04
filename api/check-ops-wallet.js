// api/check-ops-wallet.js
// Runs daily via Vercel cron (0 7 * * *)
// 1. Gets current Operations wallet ETH balance
// 2. Reads last 7 days of server-side transactions from Firestore protocolFees
// 3. Estimates average daily gas cost
// 4. Calculates how many days of runway remain
// 5. Sends email alert if runway < 3 days

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

const OPERATIONS_WALLET = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';
const ARBITRUM_RPC      = 'https://arb1.arbitrum.io/rpc';
const GAS_PER_TX        = 150000; // conservative estimate per server-side tx
const ALERT_DAYS        = 3;      // alert when runway drops below this

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const db       = getAdminDb();

        // ── 1. Current ETH balance ────────────────────────────────────────
        const balanceWei = await provider.getBalance(OPERATIONS_WALLET);
        const balanceETH = parseFloat(ethers.utils.formatEther(balanceWei));

        // ── 2. Current gas price ──────────────────────────────────────────
        const gasPriceWei = await provider.getGasPrice();
        const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPriceWei, 'gwei'));

        // Cost per transaction in ETH
        const costPerTxETH = GAS_PER_TX * parseFloat(ethers.utils.formatEther(gasPriceWei));

        // ── 3. Count server-side transactions over past 7 days ───────────
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Count equity completions
        const equitySnap = await db.collection('subprojects')
            .where('equityTransferred', '==', true)
            .where('completedAt', '>=', sevenDaysAgo)
            .get();

        // Count escrow releases
        const escrowSnap = await db.collection('subprojects')
            .where('escrowReleased', '==', true)
            .where('completedAt', '>=', sevenDaysAgo)
            .get();

        // Count equity reservations (accepted bids)
        const reserveSnap = await db.collection('subprojects')
            .where('equityReserved', '==', true)
            .where('acceptedAt', '>=', sevenDaysAgo)
            .get();

        const totalServerTxs7d = equitySnap.size + escrowSnap.size + reserveSnap.size;
        const avgDailyTxs      = totalServerTxs7d / 7;
        const avgDailyCostETH  = avgDailyTxs * costPerTxETH;

        // ── 4. Runway calculation ─────────────────────────────────────────
        const runwayDays = avgDailyCostETH > 0
            ? Math.floor(balanceETH / avgDailyCostETH)
            : 999; // infinite if no transactions

        // ETH needed to cover next 7 days at current rate
        const eth7DayNeeded = avgDailyCostETH * 7;
        const ethDeficit    = Math.max(0, eth7DayNeeded - balanceETH);

        // ── 5. Get ETH price for USD estimates ────────────────────────────
        let ethPriceUSD = 2600; // fallback
        try {
            const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
            const priceData = await priceRes.json();
            ethPriceUSD = priceData?.ethereum?.usd || ethPriceUSD;
        } catch(e) {}

        const report = {
            timestamp:        new Date().toISOString(),
            opsWallet:        OPERATIONS_WALLET,
            balanceETH:       balanceETH.toFixed(6),
            balanceUSD:       (balanceETH * ethPriceUSD).toFixed(2),
            gasPriceGwei:     gasPriceGwei.toFixed(4),
            costPerTxETH:     costPerTxETH.toFixed(6),
            costPerTxUSD:     (costPerTxETH * ethPriceUSD).toFixed(4),
            serverTxs7d:      totalServerTxs7d,
            avgDailyTxs:      avgDailyTxs.toFixed(1),
            avgDailyCostETH:  avgDailyCostETH.toFixed(6),
            avgDailyCostUSD:  (avgDailyCostETH * ethPriceUSD).toFixed(2),
            runwayDays:       runwayDays,
            eth7DayNeeded:    eth7DayNeeded.toFixed(6),
            ethDeficit:       ethDeficit.toFixed(6),
            needsAlert:       runwayDays < ALERT_DAYS
        };

        console.log('📊 Ops Wallet Report:', JSON.stringify(report, null, 2));

        // ── 6. Send alert email if runway is low ──────────────────────────
        if (report.needsAlert) {
            const alertBody = `
⚠️ NQVate Operations Wallet Low ETH Alert

Current Balance: ${report.balanceETH} ETH ($${report.balanceUSD})
Gas Price: ${report.gasPriceGwei} Gwei
Cost per Transaction: ${report.costPerTxETH} ETH ($${report.costPerTxUSD})

Past 7 Days Activity:
- Server-side transactions: ${report.serverTxs7d}
- Average daily transactions: ${report.avgDailyTxs}
- Average daily gas cost: ${report.avgDailyCostETH} ETH ($${report.avgDailyCostUSD})

Runway: ${report.runwayDays} days remaining
ETH needed for next 7 days: ${report.eth7DayNeeded} ETH
Deficit: ${report.ethDeficit} ETH

Please top up the Operations wallet:
${OPERATIONS_WALLET}

Bridge ETH to Arbitrum at: https://bridge.arbitrum.io/
            `.trim();

            await fetch(`https://www.nqvate.com/api/send-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: 'james.ferraioli@gmail.com',
                    subject: `⚠️ NQVate Ops Wallet: ${report.runwayDays} days ETH remaining`,
                    body: alertBody
                })
            });

            console.log(`🚨 Alert sent — ${report.runwayDays} days runway remaining`);
        } else {
            console.log(`✅ Ops wallet healthy — ${report.runwayDays} days runway`);
        }

        return res.json({ success: true, ...report });

    } catch(e) {
        console.error('check-ops-wallet error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
