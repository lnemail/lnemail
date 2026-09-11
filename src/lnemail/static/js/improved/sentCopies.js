/**
 * Browser-local copies of sent emails.
 *
 * LNemail does not keep a sent-mail archive on the server (outgoing
 * delivery records are purged within 30 days), so the only place a sent
 * body can live long term is the user's own browser. Copies are stored in
 * localStorage, grouped by account and keyed by the send's payment hash so
 * they can be matched against the server's recent-sends list.
 *
 * Storage is best effort: quota errors or a disabled localStorage simply
 * mean no copy is kept.
 */

const PREF_KEY = 'lnemail_keep_sent_copies';
const STORE_KEY = 'lnemail_sent_copies';
// Cap per account so localStorage (typically ~5 MB) cannot fill up silently.
const MAX_COPIES_PER_ACCOUNT = 50;

function readStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

function writeStore(store) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        return true;
    } catch (error) {
        return false;
    }
}

function pruneOldest(copies) {
    const hashes = Object.keys(copies);
    if (hashes.length <= MAX_COPIES_PER_ACCOUNT) return copies;
    hashes
        .sort((a, b) => (copies[a].created_at || '').localeCompare(copies[b].created_at || ''))
        .slice(0, hashes.length - MAX_COPIES_PER_ACCOUNT)
        .forEach(hash => { delete copies[hash]; });
    return copies;
}

/** Whether new sends should be copied to this browser (default: yes). */
export function keepCopiesEnabled() {
    try {
        return localStorage.getItem(PREF_KEY) !== '0';
    } catch (error) {
        return false;
    }
}

export function setKeepCopiesEnabled(enabled) {
    try {
        localStorage.setItem(PREF_KEY, enabled ? '1' : '0');
    } catch (error) {
        // Preference cannot be persisted; nothing else to do.
    }
}

/**
 * Store a copy of a just-sent email.
 * @param {string} accountEmail
 * @param {string} paymentHash
 * @param {{recipient: string, subject: string, body: string, attachments?: string[]}} email
 * @returns {boolean} true if the copy was written
 */
export function saveSentCopy(accountEmail, paymentHash, email) {
    if (!accountEmail || !paymentHash) return false;
    const store = readStore();
    const copies = store[accountEmail] || {};
    copies[paymentHash] = {
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        attachments: email.attachments || [],
        created_at: new Date().toISOString(),
    };
    store[accountEmail] = pruneOldest(copies);
    return writeStore(store);
}

/** Move a copy to a new key after the send invoice was re-issued. */
export function rekeySentCopy(accountEmail, oldHash, newHash) {
    if (!accountEmail || !oldHash || !newHash || oldHash === newHash) return;
    const store = readStore();
    const copies = store[accountEmail];
    if (!copies || !copies[oldHash]) return;
    copies[newHash] = copies[oldHash];
    delete copies[oldHash];
    writeStore(store);
}

export function getSentCopy(accountEmail, paymentHash) {
    const copies = readStore()[accountEmail];
    return (copies && copies[paymentHash]) || null;
}

export function countSentCopies(accountEmail) {
    const copies = readStore()[accountEmail];
    return copies ? Object.keys(copies).length : 0;
}

/** Delete every copy stored for the account. */
export function clearSentCopies(accountEmail) {
    const store = readStore();
    if (!store[accountEmail]) return;
    delete store[accountEmail];
    writeStore(store);
}
