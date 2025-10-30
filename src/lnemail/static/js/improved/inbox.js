import { state } from './state.js';
import { AUTO_REFRESH_INTERVAL } from './config.js';
import { fetchEmails, fetchEmailContent } from './api.js';
import { showStatus, renderEmailList, updateInboxCount, displayEmailAttachments, showView } from './ui.js';
import { formatEmailBody } from './utils.js';

export async function refreshInbox() {
    if (!state.accessToken) {
        showStatus('Please connect with your access token first', 'error');
        return;
    }

    const loadingElement = document.getElementById('inboxLoading');
    loadingElement.classList.remove('hidden');

    try {
        state.emails = await fetchEmails();
        renderEmailList();
        updateInboxCount();
    } catch (error) {
        // console.error('Failed to refresh inbox:', error);
        showStatus(`Failed to load emails: ${error.message}`, 'error');
        renderEmailList(); // will render empty state
    } finally {
        loadingElement.classList.add('hidden');
    }
}

export function startAutoRefresh() {
    stopAutoRefresh();
    state.autoRefreshTimer = setInterval(async () => {
        if (state.accessToken && state.currentView === 'inbox') {
            try {
                await refreshInbox();
            } catch (error) {
                // console.error('Auto-refresh failed:', error);
            }
        }
    }, AUTO_REFRESH_INTERVAL);
    // console.log(`Auto-refresh started (every ${AUTO_REFRESH_INTERVAL / 1000} seconds)`);
}

export function stopAutoRefresh() {
    if (state.autoRefreshTimer) {
        clearInterval(state.autoRefreshTimer);
        state.autoRefreshTimer = null;
        // console.log('Auto-refresh stopped');
    }
}

export async function openEmail(emailId) {
    const email = state.emails.find(e => e.id === emailId);
    if (!email) {
        showStatus('Email not found', 'error');
        return;
    }

    const wasUnread = email.read === false;

    let fullEmail = email;
    if (!email.fullContent) {
        try {
            fullEmail = await fetchEmailContent(emailId);
            email.read = true;
        } catch(error) {
            showStatus(`Failed to load email: ${error.message}`, 'error');
            return;
        }
    }

    state.currentEmail = fullEmail;

    document.getElementById('emailSubject').textContent = fullEmail.subject || 'No Subject';
    document.getElementById('emailFrom').textContent = fullEmail.from || fullEmail.sender || 'Unknown Sender';
    document.getElementById('emailDate').textContent = new Date(fullEmail.date || fullEmail.timestamp || Date.now()).toLocaleString();
    document.getElementById('emailBody').innerHTML = formatEmailBody(fullEmail.body || fullEmail.content || 'No content available');

    displayEmailAttachments(fullEmail.attachments);
    showView('emailDetail');

    if (wasUnread) {
        updateInboxCount();
        renderEmailList();
    }
}
