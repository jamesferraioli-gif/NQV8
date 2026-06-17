// ====================== EMAIL NOTIFICATIONS ======================
async function sendEmail(type, toEmail, data) {
    if (!toEmail) return;
    try {
        await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, to: toEmail, data })
        });
    } catch(e) {
        console.warn('Email notification failed:', e.message);
    }
}

async function getUserEmail(uid) {
    if (!uid) return null;
    try {
        const doc = await db.collection('users').doc(uid).get();
        return doc.exists ? doc.data().email : null;
    } catch(e) {
        return null;
    }
}

// ── Trigger: bid placed on a posting ─────────────────────────────────
// Call this inside placeBid() after saving to Firestore
async function notifyBidReceived(project, projectId) {
    const posterEmail = await getUserEmail(project.posterUid || project.ownerUid);
    if (!posterEmail) return;
    const posterDoc = await db.collection('users').doc(project.posterUid || project.ownerUid).get();
    sendEmail('bid_received', posterEmail, {
        posterName:     posterDoc.data()?.firstName || posterDoc.data()?.username || 'there',
        bidderUsername: currentUser.username,
        postingTitle:   project.title,
        bidAmount:      document.getElementById('bid-amount')?.value || 'an amount',
        postingId:      projectId
    });
}

// ── Trigger: bid accepted ─────────────────────────────────────────────
// Call this inside acceptBid() after updating Firestore
async function notifyBidAccepted(project, bid) {
    const builderEmail = await getUserEmail(bid.bidderUid);
    if (!builderEmail) return;
    sendEmail('bid_accepted', builderEmail, {
        builderName:    bid.bidderName,
        posterUsername: currentUser.username,
        postingTitle:   project.title,
        compensation:   bid.amount || project.compensation,
        postingId:      currentProjectId
    });
}

// ── Trigger: work submitted ───────────────────────────────────────────
// Call this inside submitWork() after saving submission
async function notifyWorkSubmitted(project) {
    const posterEmail = await getUserEmail(project.posterUid || project.ownerUid);
    if (!posterEmail) return;
    const posterDoc = await db.collection('users').doc(project.posterUid || project.ownerUid).get();
    sendEmail('work_submitted', posterEmail, {
        posterName:      posterDoc.data()?.firstName || posterDoc.data()?.username || 'there',
        builderUsername: currentUser.username,
        postingTitle:    project.title
    });
}

// ── Trigger: submission approved ─────────────────────────────────────
// Call this inside acceptSubmission() after releasing escrow
async function notifySubmissionApproved(project) {
    const builderEmail = await getUserEmail(project.acceptedBidderUid);
    if (!builderEmail) return;
    const builderDoc = await db.collection('users').doc(project.acceptedBidderUid).get();
    sendEmail('submission_approved', builderEmail, {
        builderName:  builderDoc.data()?.firstName || builderDoc.data()?.username || 'there',
        postingTitle: project.title,
        compensation: project.acceptedBid?.amount || project.compensation
    });
}

// ── Trigger: changes requested ───────────────────────────────────────
// Call this inside requestChanges() after saving feedback
async function notifyChangesRequested(project, feedback) {
    const builderEmail = await getUserEmail(project.acceptedBidderUid);
    if (!builderEmail) return;
    const builderDoc = await db.collection('users').doc(project.acceptedBidderUid).get();
    sendEmail('changes_requested', builderEmail, {
        builderName:    builderDoc.data()?.firstName || builderDoc.data()?.username || 'there',
        posterUsername: currentUser.username,
        postingTitle:   project.title,
        feedback
    });
}

// ── Trigger: new bounty matching skills ──────────────────────────────
// Call this inside submitBountyPosting() after saving to Firestore
async function notifyMatchingBuilders(posting, tags, category) {
    if (!tags || tags.length === 0) return;
    try {
        // Find users whose skills overlap with the posting's tags
        const usersSnap = await db.collection('users').get();
        const matches = [];
        usersSnap.forEach(doc => {
            const u = doc.data();
            if (doc.id === currentUser.uid) return; // skip poster
            if (!u.email || !u.skills || u.skills.length === 0) return;
            const overlap = u.skills.filter(s => tags.includes(s));
            if (overlap.length > 0) {
                matches.push({ email: u.email, name: u.firstName || u.username || 'there', matchedSkills: overlap });
            }
        });

        // Send to up to 50 matching users (avoid spam)
        for (const match of matches.slice(0, 50)) {
            sendEmail('new_bounty_match', match.email, {
                recipientName:  match.name,
                postingTitle:   posting.title,
                compensation:   posting.compensation,
                category:       category || 'General',
                matchedSkills:  match.matchedSkills,
                posterUsername: currentUser.username
            });
        }
    } catch(e) {
        console.warn('Skill match notification failed:', e.message);
    }
}
