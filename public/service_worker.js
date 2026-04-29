/*global chrome*/

const NEW_TAB_URLS = ['chrome://newtab/', 'edge://newtab/'];
const MAX_FREE_WORKSPACES = 3;

const isNewTabUrl = (url) => NEW_TAB_URLS.includes(url);

// Serialize all tabParentMap mutations to prevent read-modify-write races
// when multiple tab events fire in rapid succession.
let _tabParentMapQueue = Promise.resolve();
function mutateTabParentMap(updateFn) {
    _tabParentMapQueue = _tabParentMapQueue.then(async () => {
        const ret = await chrome.storage.session.get('tabParentMap');
        const tabParentMap = ret.tabParentMap || {};
        updateFn(tabParentMap);
        await chrome.storage.session.set({ tabParentMap });
    }).catch((e) => console.error('[TST] tabParentMap update failed:', e));
}

// Cryptographically random hex string for workspace IDs
function randomHex(byteCount) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// Workspace: multi-slot save/restore (max 3 in free tier)
// ============================================================

async function saveWorkspace(name, marks = {}) {
    const focusedWindow = await chrome.windows.getLastFocused();
    const windowId = focusedWindow.id;
    const tabs = await chrome.tabs.query({ windowId });
    const { tabParentMap = {} } = await chrome.storage.session.get('tabParentMap');

    const { workspaces = [] } = await chrome.storage.local.get('workspaces');
    if (workspaces.length >= MAX_FREE_WORKSPACES) {
        return { success: false, error: 'limit', max: MAX_FREE_WORKSPACES };
    }

    const tabIdToIdx = {};
    const entries = [];
    let idx = 0;
    for (const tab of tabs) {
        if (isNewTabUrl(tab.url)) continue;
        tabIdToIdx[tab.id] = idx;
        const entry = {
            url: tab.url,
            title: tab.title || '',
            index: tab.index,
            groupId: tab.groupId ?? -1,
            favIconUrl: tab.favIconUrl || null,
        };
        if (marks[tab.id]) {
            entry.mark = marks[tab.id];
        }
        if (tab.ghostPublicAPI?.identity_id) {
            entry.ghostIdentityId = tab.ghostPublicAPI.identity_id;
        }
        if (tab.ghostPublicAPI?.workspace_id) {
            entry.ghostWorkspaceId = tab.ghostPublicAPI.workspace_id;
        }
        entries.push(entry);
        idx++;
    }

    // Store parent as index into entries array
    for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        if (isNewTabUrl(tab.url)) continue;
        const ei = tabIdToIdx[tab.id];
        const parentTabId = tabParentMap[tab.id];
        entries[ei].parentIndex = (parentTabId !== undefined && tabIdToIdx[parentTabId] !== undefined)
            ? tabIdToIdx[parentTabId] : null;
    }

    // Group info
    let groups = [];
    try {
        if (chrome.tabGroups?.query) {
            const tabGroups = await chrome.tabGroups.query({});
            groups = tabGroups.map(g => ({
                id: g.id,
                title: g.title || '',
                color: g.color || 'grey',
            }));
        }
    } catch {}

    const workspace = {
        id: `ws_${Date.now()}_${randomHex(4)}`,
        name: name || 'Workspace',
        createdAt: Date.now(),
        tabCount: entries.length,
        entries,
        groups,
    };

    workspaces.push(workspace);
    await chrome.storage.local.set({ workspaces });
    return { success: true, workspace };
}

async function listWorkspaces() {
    const { workspaces = [] } = await chrome.storage.local.get('workspaces');
    return workspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        tabCount: ws.tabCount,
        groupCount: (ws.groups || []).length,
        createdAt: ws.createdAt,
    }));
}

async function getWorkspacePreview(workspaceId) {
    const { workspaces = [] } = await chrome.storage.local.get('workspaces');
    const ws = workspaces.find(w => w.id === workspaceId);
    if (!ws) return { exists: false };
    return {
        exists: true,
        id: ws.id,
        name: ws.name,
        tabCount: ws.tabCount,
        groupCount: (ws.groups || []).length,
        createdAt: ws.createdAt,
        entries: (ws.entries || []).map(e => ({
            title: e.title,
            url: e.url,
            favIconUrl: e.favIconUrl || null,
            parentIndex: e.parentIndex ?? null,
            groupId: e.groupId ?? -1,
            mark: e.mark || null,
            ghostIdentityId: e.ghostIdentityId || null,
        })),
        groups: (ws.groups || []),
    };
}

async function deleteWorkspace(workspaceId) {
    const { workspaces = [] } = await chrome.storage.local.get('workspaces');
    const filtered = workspaces.filter(w => w.id !== workspaceId);
    await chrome.storage.local.set({ workspaces: filtered });
    return { success: true };
}

async function updateWorkspace(workspaceId, updates) {
    const { workspaces = [] } = await chrome.storage.local.get('workspaces');
    const idx = workspaces.findIndex(w => w.id === workspaceId);
    if (idx === -1) return { success: false, error: 'Not found' };

    const ws = workspaces[idx];
    if (updates.name !== undefined) ws.name = updates.name;
    if (updates.entries !== undefined) {
        ws.entries = updates.entries;
        ws.tabCount = updates.entries.length;
    }
    if (updates.groups !== undefined) ws.groups = updates.groups;

    workspaces[idx] = ws;
    await chrome.storage.local.set({ workspaces });
    return { success: true };
}

async function openWorkspace(workspaceId) {
    const focusedWindow = await chrome.windows.getLastFocused();
    const windowId = focusedWindow.id;
    const { workspaces = [] } = await chrome.storage.local.get('workspaces');
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace) return { success: false, error: 'Not found' };

    const { entries, groups } = workspace;

    // Build group info map: old groupId → { title, color }
    const groupInfoMap = {};
    for (const g of (groups || [])) {
        groupInfoMap[g.id] = g;
    }

    // Find existing groups to reuse (match by title+color)
    let existingGroups = [];
    try {
        if (chrome.tabGroups?.query) {
            existingGroups = await chrome.tabGroups.query({});
        }
    } catch {}

    const existingByKey = {};
    for (const g of existingGroups) {
        const key = `${g.title || ''}\t${g.color || 'grey'}`;
        if (!existingByKey[key]) existingByKey[key] = [];
        existingByKey[key].push(g.id);
    }

    const groupIdMap = {};
    for (const g of (groups || [])) {
        const key = `${g.title}\t${g.color}`;
        if (existingByKey[key]?.length > 0) {
            groupIdMap[g.id] = existingByKey[key].shift();
        }
    }

    // Step 1: Create all tabs
    const createdTabs = [];
    let failedCount = 0;
    for (const entry of entries) {
        try {
            let tab;
            if (entry.ghostIdentityId && chrome.ghostPublicAPI?.openTab) {
                tab = await new Promise((resolve, reject) => {
                    chrome.ghostPublicAPI.openTab(
                        { url: entry.url, identity: entry.ghostIdentityId, active: false },
                        (t) => {
                            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                            else resolve(t);
                        }
                    );
                });
            } else {
                tab = await chrome.tabs.create({ url: entry.url, active: false, windowId });
            }
            createdTabs.push(tab);
        } catch (e) {
            console.warn('[TST] Failed to restore tab:', entry.url, e?.message);
            failedCount++;
            createdTabs.push(null);
        }
    }

    // Step 2: Restore tab groups
    const tabsByOldGroup = {};
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const tab = createdTabs[i];
        if (!tab || entry.groupId === -1) continue;
        if (!tabsByOldGroup[entry.groupId]) tabsByOldGroup[entry.groupId] = [];
        tabsByOldGroup[entry.groupId].push(tab.id);
    }

    for (const [oldGroupId, tabIds] of Object.entries(tabsByOldGroup)) {
        try {
            if (groupIdMap[oldGroupId]) {
                await chrome.tabs.group({ tabIds, groupId: groupIdMap[oldGroupId] });
            } else {
                const newGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
                groupIdMap[oldGroupId] = newGroupId;
                const info = groupInfoMap[Number(oldGroupId)];
                if (info) {
                    await chrome.tabGroups.update(newGroupId, { title: info.title, color: info.color });
                }
            }
        } catch (e) {
            console.error('[Workspace] group failed:', e);
        }
    }

    // Step 3: Rebuild parent map
    const { tabParentMap = {} } = await chrome.storage.session.get('tabParentMap');
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.parentIndex == null) continue;
        const childTab = createdTabs[i];
        const parentTab = createdTabs[entry.parentIndex];
        if (childTab && parentTab) {
            tabParentMap[childTab.id] = parentTab.id;
            count++;
        }
    }
    if (count > 0) {
        await chrome.storage.session.set({ tabParentMap });
    }

    // Step 4: Collect marks for newly created tabs
    const restoredMarks = {};
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].mark && createdTabs[i]) {
            restoredMarks[createdTabs[i].id] = entries[i].mark;
        }
    }

    return { success: true, tabCount: createdTabs.filter(Boolean).length, failedCount, marks: restoredMarks };
}

// ============================================================
// Message handler for UI ↔ Service Worker
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only process messages from our own extension pages and content scripts
    if (sender.id !== chrome.runtime.id) return;

    if (msg.action === 'saveWorkspace') {
        const marks = msg.marks || {};
        const name = String(msg.name || '').trim().slice(0, 100);
        saveWorkspace(name, marks).then((result) => {
            sendResponse(result);
        }).catch((e) => {
            sendResponse({ success: false, error: e.message });
        });
        return true;
    }
    if (msg.action === 'listWorkspaces') {
        listWorkspaces().then((list) => {
            sendResponse({ workspaces: list });
        }).catch(() => {
            sendResponse({ workspaces: [] });
        });
        return true;
    }
    if (msg.action === 'getWorkspacePreview') {
        getWorkspacePreview(msg.id).then((preview) => {
            sendResponse(preview);
        }).catch(() => {
            sendResponse({ exists: false });
        });
        return true;
    }
    if (msg.action === 'openWorkspace') {
        openWorkspace(msg.id).then((result) => {
            sendResponse(result);
        }).catch((e) => {
            sendResponse({ success: false, error: e.message });
        });
        return true;
    }
    if (msg.action === 'deleteWorkspace') {
        deleteWorkspace(msg.id).then((result) => {
            sendResponse(result);
        }).catch((e) => {
            sendResponse({ success: false, error: e.message });
        });
        return true;
    }
    if (msg.action === 'updateWorkspace') {
        updateWorkspace(msg.id, msg.updates || {}).then((result) => {
            sendResponse(result);
        }).catch((e) => {
            sendResponse({ success: false, error: e.message });
        });
        return true;
    }
    if (msg.action === 'openSidePanel') {
        (async () => {
            try {
                const windowId = sender.tab?.windowId
                    || (await chrome.windows.getLastFocused()).id;
                await chrome.sidePanel.open({ windowId });
                sendResponse({ success: true });
            } catch {
                sendResponse({ success: false });
            }
        })();
        return true;
    }
});

// ============================================================
// Extension lifecycle
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
    if (details.reason === 'update') {
        const prev = details.previousVersion || '';
        // Show upgrade guide for users upgrading from 1.x (popup-only era)
        if (prev.startsWith('1.')) {
            chrome.storage.local.set({ showUpgradeGuide: true });
        }
    }
});

// Click icon → open sidebar
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

// Alt+S → open sidebar via _execute_side_panel (handled natively by Chrome)

// Alt+Q → inject overlay popup into the active tab
async function openOverlayPopup() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Whitelist: only inject into http/https pages to prevent injection into
    // privileged pages (chrome://, about:, data:, file://, extension pages, etc.)
    if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
        return;
    }
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content_overlay.js'],
        });
    } catch {
        // Silently ignore injection failures (e.g. browser internal pages)
    }
}

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'open-popup') {
        openOverlayPopup();
    }
});

// ============================================================
// Tab parent tracking
// ============================================================

chrome.tabs.onCreated.addListener((tab) => {
    if (!isNewTabUrl(tab.url) && tab.openerTabId !== undefined) {
        mutateTabParentMap((map) => { map[tab.id] = tab.openerTabId; });
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && isNewTabUrl(tab.url)) {
        mutateTabParentMap((map) => { delete map[tab.id]; });
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    mutateTabParentMap((map) => { delete map[tabId]; });
});