import { state } from './state.js';
import { checkAccountAuthorization, checkApiHealth } from './api.js';
import { showStatus, showTokenModal, hideTokenModal, showMainApp, hideMainApp, updateAccountDisplay, clearComposeForm, updateLoginHealthStatus, updateLoginHealthStatusLoading, updateConnectButtonState, hidePaymentModal, hideAccountCreationModal } from './ui.js';
import { refreshInbox, startAutoRefresh, stopAutoRefresh } from './inbox.js';

function getSavedToken() {
    try {
        return localStorage.getItem('lnemail_access_token');
    } catch (error) {
        // console.error('Failed to get saved token:', error);
        return null;
    }
}

function saveToken(token) {
    try {
        localStorage.setItem('lnemail_access_token', token);
        // console.log('Token saved to localStorage');
    } catch (error) {
        // console.error('Failed to save token:', error);
    }
}

function clearSavedToken() {
    try {
        localStorage.removeItem('lnemail_access_token');
        // console.log('Saved token cleared from localStorage');
    } catch (error) {
        // console.error('Failed to clear saved token:', error);
    }
}

export async function handleConnect() {
    const token = document.getElementById('accessToken').value.trim();
    if (!token) {
        showStatus('Please enter your access token', 'error');
        return;
    }

    const connectBtn = document.getElementById('connectBtn');
    const originalText = connectBtn.innerHTML;
    connectBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
    connectBtn.disabled = true;

    try {
        // First check API health - REQUIRED before authentication
        showStatus('Checking API health...', 'info');
        const healthResult = await checkApiHealth();
        updateLoginHealthStatus(healthResult);

        if (!healthResult.success) {
            showStatus('API health check failed. Cannot proceed with authentication until API is healthy.', 'error');
            return;
        }

        showStatus('API health check passed. Proceeding with authentication...', 'info');
        state.accessToken = token;

        if (await checkAccountAuthorization()) {
            saveToken(token);
            hideTokenModal();
            showMainApp();
            updateAccountDisplay();
            await refreshInbox();
            startAutoRefresh();
            showStatus('Connected successfully!', 'success');
        } else {
            state.accessToken = null;
            showStatus('Authorization failed. Please check your access token.', 'error');
        }
    } catch (error) {
        state.accessToken = null;
        showStatus(`Connection failed: ${error.message}`, 'error');
    } finally {
        connectBtn.innerHTML = originalText;
        connectBtn.disabled = false;
    }
}

export function handleDisconnect() {
    stopAutoRefresh();
    clearSavedToken();

    // Clear payment polling if active
    if (state.paymentPollTimer) {
        clearInterval(state.paymentPollTimer);
        state.paymentPollTimer = null;
    }

    // Clear account creation polling if active
    if (state.accountCreationPollTimer) {
        clearInterval(state.accountCreationPollTimer);
        state.accountCreationPollTimer = null;
    }

    state.accessToken = null;
    state.accountInfo = null;
    state.emails = [];
    state.currentPage = 1;
    state.currentPayment = null;
    state.currentAccountCreation = null;

    hideMainApp();
    hidePaymentModal();
    hideAccountCreationModal();
    showTokenModal();
    clearComposeForm();
    document.getElementById('accessToken').value = '';
    document.getElementById('accountEmail').textContent = 'Loading...';
    document.getElementById('accountExpiry').textContent = 'Loading...';
    showStatus('Disconnected', 'info');
}

export async function tryAutoConnect() {
    // Perform initial health check first
    showTokenModal();
    await performLoginHealthCheck();

    const savedToken = getSavedToken();
    if (savedToken) {
        // Check API health before attempting auto-connect
        const healthResult = await checkApiHealth();
        updateLoginHealthStatus(healthResult);

        if (!healthResult.success) {
            showStatus('API health check failed. Auto-connect disabled until API is healthy.', 'warning');
            return;
        }

        document.getElementById('accessToken').value = savedToken;
        state.accessToken = savedToken;

        if (await checkAccountAuthorization()) {
            hideTokenModal();
            showMainApp();
            updateAccountDisplay();
            await refreshInbox();
            startAutoRefresh();
            showStatus('Connected!', 'success');
            return;
        } else {
            clearSavedToken();
            state.accessToken = null;
        }
    }
}

export async function performLoginHealthCheck() {
    updateLoginHealthStatusLoading();

    try {
        const healthResult = await checkApiHealth();
        updateLoginHealthStatus(healthResult);

        if (healthResult.success) {
            // console.log('API health check successful on login page');
        } else {
            // console.warn('API health check failed on login page:', healthResult.error);
        }
    } catch (error) {
        // console.error('Login health check error:', error);
        updateLoginHealthStatus({ success: false, error: error.message });
    }
}
