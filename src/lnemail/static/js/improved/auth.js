import { state } from './state.js';
import { RENEWAL_WARNING_DAYS } from './config.js';
import { checkAccountAuthorization, checkApiHealth } from './api.js';
import {
    showStatus, showTokenModal, hideTokenModal, showMainApp, hideMainApp,
    updateAccountDisplay, clearComposeForm, updateLoginHealthStatus,
    updateLoginHealthStatusLoading, updateConnectButtonState,
    hidePaymentModal,
    showRenewalModal, hideRenewalModal, showRenewalBanner, hideRenewalBanner,
    setExpiredOverlay
} from './ui.js';
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

            // Handle expired account: show renewal modal, block inbox
            if (state.accountInfo.is_expired) {
                setExpiredOverlay(true);
                showRenewalModal();
                showStatus('Your account has expired. Please renew to continue using your inbox.', 'error');
            } else {
                // Account is active -- load inbox normally
                await refreshInbox();
                startAutoRefresh();
                showStatus('Connected successfully!', 'success');

                // Show renewal banner if expiring within warning period
                if (state.accountInfo.days_until_expiry <= RENEWAL_WARNING_DAYS) {
                    const days = state.accountInfo.days_until_expiry;
                    const text = days <= 0
                        ? 'Your account expires today! Renew now to keep your email.'
                        : days === 1
                            ? 'Your account expires tomorrow! Renew now to keep your email.'
                            : `Your account expires in ${days} days. Renew now to avoid losing access.`;
                    showRenewalBanner(text);
                }
            }
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

    // Clear renewal polling if active
    if (state.renewalPollTimer) {
        clearInterval(state.renewalPollTimer);
        state.renewalPollTimer = null;
    }

    state.accessToken = null;
    state.accountInfo = null;
    state.emails = [];
    state.currentPage = 1;
    state.currentPayment = null;
    state.currentRenewal = null;

    hideMainApp();
    hidePaymentModal();
    hideRenewalModal();
    hideRenewalBanner();
    setExpiredOverlay(false);
    showTokenModal();
    clearComposeForm();
    document.getElementById('accessToken').value = '';
    document.getElementById('accountEmail').textContent = 'Loading...';
    document.getElementById('accountExpiry').textContent = 'Loading...';
    showStatus('Disconnected', 'info');
}

export async function tryAutoConnect() {
    // Perform initial health check first
    // Note: Don't call showTokenModal() here -- init() already hides it
    // if a saved token exists (to prevent FOUC). The modal starts as active
    // in the HTML, so it's visible by default when no token is saved.
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

            // Handle expired account: show renewal modal, block inbox
            if (state.accountInfo.is_expired) {
                setExpiredOverlay(true);
                showRenewalModal();
                showStatus('Your account has expired. Please renew to continue using your inbox.', 'error');
            } else {
                // Account is active
                await refreshInbox();
                startAutoRefresh();
                showStatus('Connected!', 'success');

                // Show renewal banner if near expiry
                if (state.accountInfo.days_until_expiry <= RENEWAL_WARNING_DAYS) {
                    const days = state.accountInfo.days_until_expiry;
                    const text = days <= 0
                        ? 'Your account expires today! Renew now to keep your email.'
                        : days === 1
                            ? 'Your account expires tomorrow! Renew now to keep your email.'
                            : `Your account expires in ${days} days. Renew now to avoid losing access.`;
                    showRenewalBanner(text);
                }
            }
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
