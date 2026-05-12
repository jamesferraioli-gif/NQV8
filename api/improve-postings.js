// ====================== CLAUDE POSTING IMPROVER ======================
async function checkAndImprovePosting(title, description, category, compensationType, postingType, onConfirm) {
    // Show loading state
    showImproveLoadingModal();

    try {
        const response = await fetch('/api/improve-posting', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, description, category, compensationType, postingType })
        });

        if (!response.ok) throw new Error('API failed');
        const data = await response.json();

        hideImproveLoadingModal();

        // If Claude's version is basically the same, skip the modal
        if (data.improved.trim() === description.trim()) {
            onConfirm(description);
            return;
        }

        showImproveSuggestionsModal(description, data.improved, data.changes, onConfirm);

    } catch (e) {
        console.warn('Improve posting failed:', e.message);
        hideImproveLoadingModal();
        // On failure, just proceed with original
        onConfirm(description);
    }
}

function showImproveLoadingModal() {
    document.getElementById('improve-loading-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'improve-loading-modal';
    modal.className = 'fixed inset-0 bg-black/95 flex items-center justify-center z-[999999]';
    modal.innerHTML = `
        <div class="bg-zinc-900 border border-zinc-700 rounded-3xl p-10 w-full max-w-sm mx-4 text-center">
            <div class="text-5xl mb-4 animate-pulse">✨</div>
            <p class="text-xl font-semibold mb-2">Reviewing your posting...</p>
            <p class="text-zinc-400 text-sm">Claude is checking for clear deliverables and scope.</p>
        </div>
    `;
    document.body.appendChild(modal);
}

function hideImproveLoadingModal() {
    document.getElementById('improve-loading-modal')?.remove();
}

function showImproveSuggestionsModal(original, improved, changes, onConfirm) {
    document.getElementById('improve-suggestions-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'improve-suggestions-modal';
    modal.className = 'fixed inset-0 bg-black/95 flex items-center justify-center z-[999999] overflow-auto';
    modal.innerHTML = `
        <div class="bg-zinc-900 border border-zinc-700 rounded-3xl p-6 md:p-8 w-full max-w-3xl mx-4 my-8">
            <div class="flex items-center gap-3 mb-2">
                <span class="text-3xl">✨</span>
                <h3 class="text-2xl font-bold">Claude Suggested Improvements</h3>
            </div>
            <p class="text-zinc-400 text-sm mb-6">Your posting was reviewed for clarity and concrete deliverables. Choose which version to use — you must select one to continue.</p>

            <!-- What changed -->
            <div class="bg-cyan-500/10 border border-cyan-500/20 rounded-2xl p-4 mb-6">
                <p class="text-cyan-400 text-sm font-semibold mb-2">What was improved:</p>
                <ul class="space-y-1">
                    ${changes.map(c => `<li class="text-zinc-300 text-sm flex gap-2"><span class="text-emerald-400 flex-shrink-0">✓</span>${c}</li>`).join('')}
                </ul>
            </div>

            <!-- Side by side comparison -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div class="border-2 border-zinc-700 rounded-2xl p-5" id="original-panel">
                    <p class="text-xs text-zinc-500 font-semibold uppercase tracking-wider mb-3">Your Original</p>
                    <p class="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">${original}</p>
                </div>
                <div class="border-2 border-emerald-500/40 bg-emerald-500/5 rounded-2xl p-5" id="improved-panel">
                    <p class="text-xs text-emerald-400 font-semibold uppercase tracking-wider mb-3">Claude's Version</p>
                    <p class="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">${improved}</p>
                </div>
            </div>

            <!-- Must choose one -->
            <p class="text-center text-xs text-zinc-500 mb-4">You must choose one option to proceed with your posting.</p>

            <div class="grid grid-cols-2 gap-4">
                <button id="keep-original-btn"
                        onclick="selectPostingVersion('original')"
                        class="py-4 border-2 border-zinc-600 hover:border-zinc-400 rounded-2xl font-medium text-zinc-300 transition-all">
                    Keep Mine
                </button>
                <button id="use-improved-btn"
                        onclick="selectPostingVersion('improved')"
                        class="py-4 border-2 border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-2xl font-semibold text-emerald-400 transition-all">
                    ✅ Use Claude's Version
                </button>
            </div>

            <!-- Confirm button — only enabled after selection -->
            <button id="confirm-posting-btn"
                    disabled
                    onclick="confirmPostingVersion()"
                    class="w-full mt-4 py-4 bg-white text-black font-semibold rounded-2xl opacity-30 cursor-not-allowed transition-all">
                Continue with Selected Version →
            </button>
        </div>
    `;
    document.body.appendChild(modal);

    // Store for confirm handler
    window._postingVersions = { original, improved };
    window._selectedPostingVersion = null;
    window._onPostingConfirm = onConfirm;
}

function selectPostingVersion(version) {
    window._selectedPostingVersion = version;

    const originalBtn = document.getElementById('keep-original-btn');
    const improvedBtn = document.getElementById('use-improved-btn');
    const confirmBtn = document.getElementById('confirm-posting-btn');

    if (version === 'original') {
        originalBtn.classList.add('border-white', 'text-white');
        originalBtn.classList.remove('border-zinc-600', 'text-zinc-300');
        improvedBtn.classList.remove('border-emerald-500', 'bg-emerald-500/10');
        improvedBtn.classList.add('border-zinc-600', 'text-zinc-400');
    } else {
        improvedBtn.classList.add('border-emerald-500', 'bg-emerald-500/20', 'text-emerald-400');
        originalBtn.classList.remove('border-white', 'text-white');
        originalBtn.classList.add('border-zinc-600', 'text-zinc-300');
    }

    confirmBtn.disabled = false;
    confirmBtn.classList.remove('opacity-30', 'cursor-not-allowed');
}

function confirmPostingVersion() {
    if (!window._selectedPostingVersion) return;
    const chosen = window._selectedPostingVersion === 'improved'
        ? window._postingVersions.improved
        : window._postingVersions.original;

    document.getElementById('improve-suggestions-modal')?.remove();
    window._onPostingConfirm(chosen);
}
