import { sendEmail, checkApiHealth, deleteEmails, checkPaymentStatus, createEmailAccount, checkAccountPaymentStatus } from './api.js';
import {
    showStatus,
    showView,
    clearComposeForm,
    updateHealthStatus,
    updateHealthStatusLoading,
    getSelectedEmailIds,
    clearSelectedEmails,
    renderEmailList,
    updateConnectButtonState,
    showPaymentModal,
    hidePaymentModal,
    updatePaymentModal,
    updatePaymentStatus,
    showAccountCreationModal,
    hideAccountCreationModal,
    updateAccountCreationModal,
    updateAccountPaymentStatus,
    updatePaymentModalWithDelivery,
    initMobileMenu
} from './ui.js';
import { handleConnect, handleDisconnect, tryAutoConnect, performLoginHealthCheck } from './auth.js';
import { isValidEmail } from './utils.js';
import { refreshInbox, startAutoRefresh, stopAutoRefresh } from './inbox.js';
import { payWithWebLN } from './webln.js';
import { HEALTH_CHECK_INTERVAL, PAYMENT_POLL_INTERVAL } from './config.js';
import { state } from './state.js';

async function handleRefreshClick() {
    const refreshBtn = document.getElementById('refreshBtn');
    const refreshIcon = refreshBtn.querySelector('i');

    const originalClasses = refreshIcon.className;
    refreshIcon.className = 'fas fa-sync-alt fa-spin';
    refreshBtn.disabled = true;

    try {
        await refreshInbox();
    } finally {
        refreshIcon.className = originalClasses;
        refreshBtn.disabled = false;
    }
}

async function handleHealthCheck() {
    const refreshHealthBtn = document.getElementById('refreshHealthBtn');
    const refreshHealthIcon = refreshHealthBtn.querySelector('i');

    const originalClasses = refreshHealthIcon.className;
    refreshHealthIcon.className = 'fas fa-sync-alt fa-spin';
    refreshHealthBtn.disabled = true;

    updateHealthStatusLoading();

    try {
        const healthResult = await checkApiHealth();
        updateHealthStatus(healthResult);

        if (healthResult.success) {
            showStatus('LNEmail API is currently healthy!', 'success');
        }
    } catch (error) {
        updateHealthStatus({ success: false, error: error.message });
    } finally {
        refreshHealthIcon.className = originalClasses;
        refreshHealthBtn.disabled = false;
    }
}

async function performAutomaticHealthCheck() {
    try {
        const healthResult = await checkApiHealth();
        updateHealthStatus(healthResult);

        // Only show error messages for automatic checks, not success messages
        if (!healthResult.success) {
            showStatus('Automatic health check failed - API may be down', 'error');
        }
    } catch (error) {
        updateHealthStatus({ success: false, error: error.message });
    }
}

async function handleSendEmail(e) {
    e.preventDefault();

    const recipient = document.getElementById('recipient').value.trim();
    const subject = document.getElementById('subject').value.trim();
    const body = document.getElementById('body').value.trim();
    const inReplyTo = document.getElementById('recipient').dataset.inReplyTo || null;
    const references = document.getElementById('recipient').dataset.references || null;

    if (!recipient || !subject || !body) {
        showStatus('Please fill in all fields', 'error');
        return;
    }

    if (!isValidEmail(recipient)) {
        showStatus('Please enter a valid email address', 'error');
        return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Invoice...';
    submitBtn.disabled = true;

    try {
        const invoiceResponse = await sendEmail(recipient, subject, body, inReplyTo, references);

        state.currentPayment = {
            payment_hash: invoiceResponse.payment_hash,
            payment_request: invoiceResponse.payment_request,
            price_sats: invoiceResponse.price_sats,
            sender_email: invoiceResponse.sender_email,
            recipient: invoiceResponse.recipient,
            subject: invoiceResponse.subject,
            originalFormData: { recipient, subject, body }
        };

        updatePaymentModal(invoiceResponse);
        showPaymentModal();

        startPaymentPolling();

        showStatus('Lightning invoice created! Please scan the QR code to pay.', 'info');

    } catch (error) {
        showStatus(`Failed to create invoice: ${error.message}`, 'error');
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}

function handleReply() {
    if (!state.currentEmail) {
        showStatus('No email selected to reply to', 'error');
        return;
    }

    const email = state.currentEmail;
    const senderEmail = email.sender || email.from || '';
    const senderMatch = senderEmail.match(/<(.+?)>/) || senderEmail.match(/([^\s]+@[^\s]+)/);
    const replyTo = senderMatch ? senderMatch[1] : senderEmail;

    const originalSubject = email.subject || 'No Subject';
    const replySubject = originalSubject.startsWith('Re: ') ? originalSubject : `Re: ${originalSubject}`;

    const messageId = email.message_id;
    const existingReferences = email.references;
    const newReferences = existingReferences ? `${existingReferences} ${messageId}` : messageId;

    document.getElementById('recipient').value = replyTo;
    document.getElementById('subject').value = replySubject;
    document.getElementById('body').value = '';

    if (messageId) {
        document.getElementById('recipient').dataset.inReplyTo = messageId;
        document.getElementById('recipient').dataset.references = newReferences;
    }

    showView('compose');
    showStatus(`Replying to ${replyTo}`, 'info');
}

function startPaymentPolling() {
    if (state.paymentPollTimer) {
        clearInterval(state.paymentPollTimer);
    }

    const pollPayment = async () => {
        if (!state.currentPayment) {
            return;
        }

        try {
            const statusResponse = await checkPaymentStatus(state.currentPayment.payment_hash);
            updatePaymentModalWithDelivery(statusResponse);

            if (statusResponse.delivery_status === 'sent') {
                stopPaymentPolling();
                refreshInbox();

                // Update UI to show success state and allow closing
                const cancelBtn = document.getElementById('cancelPaymentBtn');
                const copyBtn = document.getElementById('copyInvoiceBtn');

                if (cancelBtn) {
                    cancelBtn.innerHTML = '<i class="fas fa-check"></i> Close';
                    cancelBtn.className = 'btn-primary';
                }
                if (copyBtn) {
                    copyBtn.style.display = 'none';
                }
            } else if (statusResponse.payment_status === 'expired') {
                updatePaymentStatus('error', 'Payment expired. Please try again.');
                stopPaymentPolling();
            }
        } catch (error) {
            updatePaymentStatus('error', 'Failed to check payment status');
        }
    };

    // Poll immediately, then every 3 seconds
    pollPayment();
    state.paymentPollTimer = setInterval(pollPayment, PAYMENT_POLL_INTERVAL);
}

function stopPaymentPolling() {
    if (state.paymentPollTimer) {
        clearInterval(state.paymentPollTimer);
        state.paymentPollTimer = null;
    }
}

function handleCancelPayment() {
    stopPaymentPolling();
    hidePaymentModal();

    const statusText = document.getElementById('paymentStatusText');
    const isSuccess = statusText && (
        statusText.textContent.includes('Payment confirmed') ||
        statusText.textContent.includes('Email delivered')
    );

    state.currentPayment = null;

    if (isSuccess) {
        clearComposeForm();
        showView('inbox');
    } else {
        showStatus('Payment cancelled', 'info');
    }

    // Reset modal buttons for next time
    setTimeout(() => {
        const cancelBtn = document.getElementById('cancelPaymentBtn');
        const copyBtn = document.getElementById('copyInvoiceBtn');

        if (cancelBtn) {
            cancelBtn.innerHTML = '<i class="fas fa-times"></i> Cancel';
            cancelBtn.className = 'btn-secondary';
        }
        if (copyBtn) {
            copyBtn.style.display = '';
        }
        // Reset status
        updatePaymentStatus('pending', 'Waiting for payment...');
    }, 300);
}

async function handleCopyInvoice() {
    if (!state.currentPayment || !state.currentPayment.payment_request) {
        showStatus('No invoice to copy', 'error');
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(state.currentPayment.payment_request);
        } else {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = state.currentPayment.payment_request;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }

        showStatus('Lightning invoice copied to clipboard!', 'success');
    } catch (error) {
        // console.error('Failed to copy invoice:', error);
        showStatus('Failed to copy invoice to clipboard', 'error');
    }
}

async function handleDeleteSelected() {
    const selectedIds = getSelectedEmailIds();

    if (selectedIds.length === 0) {
        showStatus('No emails selected for deletion', 'error');
        return;
    }

    // Show confirmation dialog
    const confirmMessage = `Are you sure you want to delete ${selectedIds.length} email${selectedIds.length > 1 ? 's' : ''}? This action cannot be undone.`;
    if (!confirm(confirmMessage)) {
        return;
    }

    const deleteBtn = document.getElementById('deleteSelectedBtn');
    const originalText = deleteBtn.innerHTML;
    deleteBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
    deleteBtn.disabled = true;

    try {
        const response = await deleteEmails(selectedIds);

        if (response.success) {
            showStatus(`Successfully deleted ${selectedIds.length} email${selectedIds.length > 1 ? 's' : ''}`, 'success');
            clearSelectedEmails();
            // Refresh the inbox to show updated email list
            await refreshInbox();
        } else {
            throw new Error(response.error || 'Failed to delete emails');
        }
    } catch (error) {
        showStatus(`Failed to delete emails: ${error.message}`, 'error');
    } finally {
        deleteBtn.innerHTML = originalText;
        deleteBtn.disabled = selectedIds.length === 0;
    }
}

async function handleCopyEmail() {
    const emailSpan = document.getElementById('accountEmail');
    const emailText = emailSpan.textContent;

    // Check if the email is loaded (not "Loading...")
    if (!emailText || emailText === 'Loading...') {
        showStatus('Email address not yet loaded', 'error');
        return;
    }

    try {
        // Use the modern Clipboard API if available
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(emailText);
        } else {
            // Fallback for older browsers or non-secure contexts
            const textArea = document.createElement('textarea');
            textArea.value = emailText;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }

        showStatus(`Email address copied: ${emailText}`, 'success');
    } catch (error) {
        // console.error('Failed to copy email:', error);
        showStatus('Failed to copy email address to clipboard', 'error');
    }
}

function bindEvents() {
    // Authentication events
    document.getElementById('connectBtn').addEventListener('click', handleConnect);
    document.getElementById('disconnectBtn').addEventListener('click', handleDisconnect);

    // Login health check events
    document.getElementById('loginRefreshHealthBtn').addEventListener('click', async () => {
        const loginRefreshHealthBtn = document.getElementById('loginRefreshHealthBtn');
        const loginRefreshHealthIcon = loginRefreshHealthBtn.querySelector('i');

        const originalClasses = loginRefreshHealthIcon.className;
        loginRefreshHealthIcon.className = 'fas fa-sync-alt fa-spin';
        loginRefreshHealthBtn.disabled = true;

        try {
            await performLoginHealthCheck();
        } finally {
            loginRefreshHealthIcon.className = originalClasses;
            loginRefreshHealthBtn.disabled = false;
        }
    });

    // Toggle login health details
    document.getElementById('loginHealthStatus').addEventListener('click', () => {
        const details = document.getElementById('loginHealthDetails');
        details.classList.toggle('hidden');
    });

    // Allow enter key to connect (if health check passes)
    document.getElementById('accessToken').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const connectBtn = document.getElementById('connectBtn');
            if (!connectBtn.disabled) {
                handleConnect();
            }
        }
    });

    // Navigation events
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            showView(item.dataset.view);
        });
    });

    // Compose events
    document.getElementById('composeBtn').addEventListener('click', () => showView('compose'));
    document.getElementById('composeForm').addEventListener('submit', handleSendEmail);
    document.getElementById('clearForm').addEventListener('click', clearComposeForm);

    // Email list events
    document.getElementById('refreshBtn').addEventListener('click', handleRefreshClick);
    document.getElementById('backToInbox').addEventListener('click', () => showView('inbox'));
    document.getElementById('replyBtn').addEventListener('click', handleReply);

    // Health check events
    document.getElementById('refreshHealthBtn').addEventListener('click', handleHealthCheck);

    // Delete emails events - using event delegation since button is dynamically created
    document.addEventListener('click', (e) => {
        if (e.target.closest('#deleteSelectedBtn')) {
            handleDeleteSelected();
        }
    });

    // Copy email address events
    document.getElementById('accountEmailContainer').addEventListener('click', handleCopyEmail);

    // Payment modal events
    document.getElementById('cancelPaymentBtn').addEventListener('click', handleCancelPayment);
    document.getElementById('copyInvoiceBtn').addEventListener('click', handleCopyInvoice);
    document.getElementById('weblnPayBtn').addEventListener('click', handleWebLNPayment);

    // Account creation events
    document.getElementById('createAccountLink').addEventListener('click', handleCreateAccount);
    document.getElementById('cancelAccountCreationBtn').addEventListener('click', handleCancelAccountCreation);
    document.getElementById('copyAccountInvoiceBtn').addEventListener('click', handleCopyAccountInvoice);
    document.getElementById('accountWeblnPayBtn').addEventListener('click', handleAccountWebLNPayment);
    document.getElementById('accountAccessToken').addEventListener('click', handleCopyAccessToken);
}

function init() {
    initMobileMenu();
    bindEvents();
    tryAutoConnect();

    // Perform initial health check
    handleHealthCheck();

    // Set up automatic health checking every 5 minutes
    setInterval(performAutomaticHealthCheck, HEALTH_CHECK_INTERVAL);
    // console.log(`Automatic health checking enabled (every ${HEALTH_CHECK_INTERVAL / 60000} minutes)`);
}

// Initialize the application
document.addEventListener('DOMContentLoaded', init);

async function handleCreateAccount() {
    const createBtn = document.getElementById('createAccountLink');
    const originalText = createBtn.textContent;
    createBtn.textContent = 'Creating account...';
    createBtn.style.pointerEvents = 'none';

    try {
        // Call the API to create email account
        const accountResponse = await createEmailAccount();

        // Store account creation data in state
        state.currentAccountCreation = {
            payment_hash: accountResponse.payment_hash,
            payment_request: accountResponse.payment_request,
            price_sats: accountResponse.price_sats,
            email_address: accountResponse.email_address,
            access_token: accountResponse.access_token,
            expires_at: accountResponse.expires_at
        };

        // Show account creation modal with invoice details
        updateAccountCreationModal(accountResponse);
        showAccountCreationModal();

        // Start polling for payment status
        startAccountCreationPolling();

        showStatus('Lightning invoice created for account! Please scan the QR code to pay.', 'info');

    } catch (error) {
        showStatus(`Failed to create account invoice: ${error.message}`, 'error');
    } finally {
        createBtn.textContent = originalText;
        createBtn.style.pointerEvents = 'auto';
    }
}

function startAccountCreationPolling() {
    if (state.accountCreationPollTimer) {
        clearInterval(state.accountCreationPollTimer);
    }

    // Check immediately
    checkAccountCreationPaymentStatus();

    // Then poll every 3 seconds
    state.accountCreationPollTimer = setInterval(() => {
        checkAccountCreationPaymentStatus();
    }, PAYMENT_POLL_INTERVAL);
}

function stopAccountCreationPolling() {
    if (state.accountCreationPollTimer) {
        clearInterval(state.accountCreationPollTimer);
        state.accountCreationPollTimer = null;
    }
}

async function checkAccountCreationPaymentStatus() {
    if (!state.currentAccountCreation) {
        stopAccountCreationPolling();
        return;
    }

    try {
        const statusResponse = await checkAccountPaymentStatus(state.currentAccountCreation.payment_hash);

        if (statusResponse.payment_status === 'paid') {
            // Payment successful - account created!
            updateAccountPaymentStatus('success', 'Payment confirmed! Account created successfully!');

            // Auto-fill the access token and proceed with authentication
            setTimeout(async () => {
                hideAccountCreationModal();

                // Fill in the access token
                document.getElementById('accessToken').value = state.currentAccountCreation.access_token;

                // Clear account creation state
                state.currentAccountCreation = null;

                // Show success message with email address
                showStatus(`Account created! Email: ${statusResponse.email_address}. Connecting...`, 'success');

                // Automatically connect with the new token
                await handleConnect();

            }, 2000);

            stopAccountCreationPolling();

        } else if (statusResponse.payment_status === 'expired') {
            updateAccountPaymentStatus('error', 'Payment expired. Please try again.');
            stopAccountCreationPolling();
        } else {
            // Still pending
            updateAccountPaymentStatus('pending', 'Waiting for payment...');
        }

    } catch (error) {
        // console.error('Failed to check account payment status:', error);
        updateAccountPaymentStatus('error', `Payment check failed: ${error.message}`);
    }
}

async function handleCancelAccountCreation() {
    stopAccountCreationPolling();
    state.currentAccountCreation = null;
    hideAccountCreationModal();
    showStatus('Account creation cancelled', 'info');
}

async function handleCopyAccountInvoice() {
    if (!state.currentAccountCreation) {
        showStatus('No invoice to copy', 'error');
        return;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(state.currentAccountCreation.payment_request);
        } else {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = state.currentAccountCreation.payment_request;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            textArea.remove();
        }

        showStatus('Lightning invoice copied to clipboard!', 'success');
    } catch (error) {
        // console.error('Failed to copy account invoice:', error);
        showStatus('Failed to copy invoice to clipboard', 'error');
    }
}

async function handleCopyAccessToken() {
    const tokenText = document.getElementById('accountAccessTokenText').textContent;

    // Check if the token is loaded (not "-")
    if (!tokenText || tokenText === '-') {
        showStatus('Access token not yet loaded', 'error');
        return;
    }

    try {
        // Use the modern Clipboard API if available
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(tokenText);
        } else {
            // Fallback for older browsers or non-secure contexts
            const textArea = document.createElement('textarea');
            textArea.value = tokenText;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }

        showStatus('Access token copied to clipboard!', 'success');
    } catch (error) {
        // console.error('Failed to copy access token:', error);
        showStatus('Failed to copy access token to clipboard', 'error');
    }
}

async function handleWebLNPayment() {
    if (!state.currentPayment || !state.currentPayment.payment_request) return;
    await payWithWebLN(state.currentPayment.payment_request);
}

async function handleAccountWebLNPayment() {
    if (!state.currentAccountCreation || !state.currentAccountCreation.payment_request) return;
    await payWithWebLN(state.currentAccountCreation.payment_request);
}
