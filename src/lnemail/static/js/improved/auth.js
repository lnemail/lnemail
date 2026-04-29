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

/**
 * Open the recovery modal that lets a logged-in user view, copy, and
 * save their access token. The token is read from in-memory state which
 * is in turn loaded from ``localStorage`` on connect, providing a UX
 * recovery path for users who forget where they stored the token.
 */
export function showAccessTokenRecovery() {
    const modal = document.getElementById('showTokenModal');
    const emailInput = document.getElementById('recoverEmail');
    const tokenInput = document.getElementById('recoverToken');
    if (!modal || !tokenInput) {
        return;
    }
    if (emailInput && state.accountInfo) {
        emailInput.value = state.accountInfo.email_address || '';
    }
    tokenInput.value = state.accessToken || '';
    tokenInput.type = 'password';
    const toggle = document.getElementById('recoverTokenToggle');
    if (toggle) {
        toggle.innerHTML = '<i class="fas fa-eye"></i>';
    }
    modal.classList.add('active');
}

export function hideAccessTokenRecovery() {
    const modal = document.getElementById('showTokenModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

/**
 * Wire up event handlers for the access-token recovery modal. Idempotent
 * across page loads -- callers should invoke this once during init.
 */
export function bindAccessTokenRecovery() {
    const showBtn = document.getElementById('showTokenBtn');
    const closeBtn = document.getElementById('recoverCloseBtn');
    const toggleBtn = document.getElementById('recoverTokenToggle');
    const copyBtn = document.getElementById('recoverTokenCopy');
    const form = document.getElementById('recoverCredentialsForm');
    const tokenInput = document.getElementById('recoverToken');

    if (showBtn) {
        showBtn.addEventListener('click', showAccessTokenRecovery);
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', hideAccessTokenRecovery);
    }
    if (toggleBtn && tokenInput) {
        toggleBtn.addEventListener('click', () => {
            const showing = tokenInput.type === 'text';
            tokenInput.type = showing ? 'password' : 'text';
            toggleBtn.innerHTML = showing
                ? '<i class="fas fa-eye"></i>'
                : '<i class="fas fa-eye-slash"></i>';
        });
    }
    if (copyBtn && tokenInput) {
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(tokenInput.value);
                showStatus('Access token copied to clipboard', 'success');
            } catch (err) {
                showStatus('Failed to copy token: ' + err.message, 'error');
            }
        });
    }
    if (form && tokenInput) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const emailInput = document.getElementById('recoverEmail');
            const email = emailInput ? emailInput.value : '';
            const token = tokenInput.value;
            // Prefer the Credential Management API where available; fall
            // back to the form-submit heuristic that all major password
            // managers detect.
            let stored = false;
            if ('credentials' in navigator && window.PasswordCredential) {
                try {
                    const cred = new window.PasswordCredential({
                        id: email,
                        password: token,
                        name: email,
                    });
                    await navigator.credentials.store(cred);
                    stored = true;
                    showStatus('Credentials offered to your password manager.', 'success');
                } catch (err) {
                    // Fall through to form-submit heuristic below.
                }
            }
            if (!stored) {
                // Reveal the token so password managers reading the DOM
                // can see the value, then re-mask after a short delay.
                const wasMasked = tokenInput.type === 'password';
                if (wasMasked) tokenInput.type = 'text';
                showStatus(
                    'If your password manager prompts to save, accept to store these credentials.',
                    'info'
                );
                // Re-mask shortly after so the token does not stay
                // visible on screen.
                setTimeout(() => {
                    if (wasMasked) tokenInput.type = 'password';
                }, 1500);
            }
        });
    }
}
