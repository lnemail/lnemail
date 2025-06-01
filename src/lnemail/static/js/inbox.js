/**
* Inbox functionality for LNemail
*/
document.addEventListener('DOMContentLoaded', function() {
    // Global Constants
    const API_BASE_URL = '/api/v1';
    const STORAGE_KEYS = {
        accessToken: 'lnemail_access_token',
        emailAddress: 'lnemail_email_address',
        sendPaymentData: 'lnemail_send_payment_data' // New key for pending send payments
    };
    const ENDPOINTS = {
        account: `${API_BASE_URL}/account`,
        listEmails: `${API_BASE_URL}/emails`,
        getEmail: (emailId) => `${API_BASE_URL}/emails/${emailId}`,
        sendEmail: `${API_BASE_URL}/email/send`, // New endpoint for sending email
        sendPaymentStatus: (paymentHash) => `${API_BASE_URL}/email/send/status/${paymentHash}` // New endpoint for checking send payment status
    };
    // DOM Elements
    const authSection = document.getElementById('auth-section');
    const inboxSection = document.getElementById('inbox-section');
    const emailListContainer = document.getElementById('email-list-container');
    const emailContentSection = document.getElementById('email-content');
    const composeEmailSection = document.getElementById('compose-email-section'); // New compose section
    const accessTokenInput = document.getElementById('access-token-input');
    const authBtn = document.getElementById('auth-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const composeBtn = document.getElementById('compose-btn'); // New compose button
    const backToListBtn = document.getElementById('back-to-list');
    const emailDisplay = document.getElementById('email-display');
    const emailList = document.getElementById('email-list');
    const noEmailsDiv = document.querySelector('.no-emails');
    const loadingDiv = document.querySelector('.loading-emails');
    // Email content elements
    const emailSubject = document.getElementById('email-subject');
    const emailFrom = document.getElementById('email-from');
    const emailTo = document.getElementById('email-to');
    const emailDate = document.getElementById('email-date');
    const emailText = document.getElementById('email-text');
    const emailHtml = document.getElementById('email-html');
    const emailAttachments = document.getElementById('email-attachments');
    const attachmentsList = document.getElementById('attachments-list');
    const attachmentsCount = document.getElementById('email-attachments-count');
    const attachmentCountSpan = document.getElementById('attachment-count');
    // Compose elements
    const composeToInput = document.getElementById('compose-to');
    const composeSubjectInput = document.getElementById('compose-subject');
    const composeBodyTextarea = document.getElementById('compose-body');
    const sendEmailBtn = document.getElementById('send-email-btn');
    const cancelComposeBtn = document.getElementById('cancel-compose-btn');
    const sendPaymentPendingDiv = document.getElementById('send-payment-pending'); // New payment section for sending
    const sendQrContainer = document.getElementById('send-qrcode');
    const sendBolt11Invoice = document.getElementById('send-bolt11-invoice');
    const sendInvoiceAmount = document.getElementById('send-invoice-amount');
    const sendCopyInvoiceBtn = document.getElementById('send-copy-invoice');
    const sendWeblnPayBtn = document.getElementById('send-webln-pay-btn');
    const sendStatusText = document.getElementById('send-status-text');
    const sendLoader = document.getElementById('send-loader');
    const cancelSendPaymentBtn = document.getElementById('cancel-send-payment-btn');
    let autoRefreshInterval = null;
    let currentEmailAddress = '';
    let emailsData = []; // Store for sorting and filtering
    let currentSendPaymentHash = '';
    let sendCheckInterval = null;
    // Utility functions for API requests and notifications
    async function apiRequest(url, options = {}) {
        const token = localStorage.getItem(STORAGE_KEYS.accessToken);
        const headers = {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` }),
            ...(options.headers || {})
        };
        const response = await fetch(url, { ...options, headers });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `API request failed with status ${response.status}`);
        }
        return response.json();
    }
    function showNotification(message, type = 'info', duration = 3000) {
        const notificationContainer = document.getElementById('notification-container');
        if (!notificationContainer) {
            console.warn('Notification container not found.');
            return;
        }
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        notificationContainer.appendChild(notification);
        setTimeout(() => {
            notification.classList.add('hide');
            notification.addEventListener('transitionend', () => notification.remove());
        }, duration);
    }
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            showNotification('Copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy text: ', err);
            showNotification('Failed to copy text.', 'error');
        });
    }
    // Check for existing access token
    const storedToken = localStorage.getItem(STORAGE_KEYS.accessToken);
    if (storedToken) {
        accessTokenInput.value = storedToken;
        authenticateAndLoadInbox(storedToken);
    }
    // Check for pending send payment on page load
    const storedSendPaymentData = sessionStorage.getItem(STORAGE_KEYS.sendPaymentData);
    if (storedSendPaymentData) {
        try {
            const paymentData = JSON.parse(storedSendPaymentData);
            currentSendPaymentHash = paymentData.payment_hash;
            displaySendPaymentScreen(paymentData);
            checkSendPaymentStatus();
            sendCheckInterval = setInterval(checkSendPaymentStatus, 3000);
        } catch (error) {
            console.error('Error parsing stored send payment data:', error);
            sessionStorage.removeItem(STORAGE_KEYS.sendPaymentData);
        }
    }
    // Event Listeners
    authBtn.addEventListener('click', handleAuthentication);
    logoutBtn.addEventListener('click', handleLogout);
    refreshBtn.addEventListener('click', fetchEmails);
    composeBtn.addEventListener('click', showComposeForm); // New event listener
    backToListBtn.addEventListener('click', showEmailList);
    sendEmailBtn.addEventListener('click', handleSendEmail); // New event listener
    cancelComposeBtn.addEventListener('click', cancelCompose); // New event listener
    sendCopyInvoiceBtn.addEventListener('click', () => { // New event listener
        copyToClipboard(sendBolt11Invoice.textContent);
    });
    cancelSendPaymentBtn.addEventListener('click', cancelSendPayment); // New event listener
    // Authentication and initialization
    function addResetButton() {
        if (document.getElementById('reset-auth-btn')) return;
        const resetContainer = document.createElement('div');
        resetContainer.className = 'form-group reset-container';
        resetContainer.style.marginTop = '20px';
        resetContainer.style.textAlign = 'center';
        const resetBtn = document.createElement('button');
        resetBtn.id = 'reset-auth-btn';
        resetBtn.className = 'btn secondary';
        resetBtn.textContent = 'Cancel and Start Over';
        resetBtn.addEventListener('click', handleLogout);
        resetContainer.appendChild(resetBtn);
        authSection.appendChild(resetContainer);
    }
    async function handleAuthentication() {
        const token = accessTokenInput.value.trim();
        if (!token) {
            showNotification('Please enter your access token', 'error');
            return;
        }
        try {
            localStorage.setItem(STORAGE_KEYS.accessToken, token);
            await authenticateAndLoadInbox(token);
        } catch (error) {
            showNotification('Invalid access token', 'error');
            localStorage.removeItem(STORAGE_KEYS.accessToken);
        }
    }
    async function authenticateAndLoadInbox(token) {
        showLoadingState();
        try {
            const accountData = await apiRequest(ENDPOINTS.account);
            currentEmailAddress = accountData.email_address;
            emailDisplay.textContent = currentEmailAddress;
            await fetchEmails();
            authSection.classList.add('hidden');
            inboxSection.classList.remove('hidden');
            startAutoRefresh();
        } catch (error) {
            showNotification('Invalid access token', 'error');
            localStorage.removeItem(STORAGE_KEYS.accessToken);
            throw error;
        }
    }
    // Email fetching and rendering
    async function fetchEmails() {
        showLoadingState();
        try {
            const response = await apiRequest(ENDPOINTS.listEmails);
            const emails = Array.isArray(response) ? response : (response.emails || []);
            // Store emails data for future operations
            emailsData = emails;
            // Emails are already sorted by date in reverse chronological order from backend
            renderEmails(emails);
        } catch (error) {
            handleEmailFetchError(error);
        }
    }
    function renderEmails(emails) {
        emailList.innerHTML = '';
        if (emails.length === 0) {
            noEmailsDiv.classList.remove('hidden');
            loadingDiv.classList.add('hidden');
            return;
        }
        emails.forEach(email => {
            const emailElement = createEmailListItem(email);
            emailList.appendChild(emailElement);
        });
        loadingDiv.classList.add('hidden');
        noEmailsDiv.classList.add('hidden');
    }
    function createEmailListItem(email) {
        const emailElement = document.createElement('div');
        emailElement.className = `email-list-item${!email.read ? ' unread' : ''}`;
        const readStatus = email.read ? 'read' : 'unread';
        emailElement.innerHTML = `
            <div class="email-col status">
                <span class="read-status ${readStatus}"></span>
            </div>
            <div class="email-col from" title="${escapeHtml(email.sender || email.from)}">
                ${escapeHtml(truncateText(email.sender || email.from, 25))}
            </div>
            <div class="email-col subject" title="${escapeHtml(email.subject)}">
                ${escapeHtml(email.subject || '(No Subject)')}
            </div>
            <div class="email-col date" title="${formatFullDate(email.date)}">
                ${formatDate(email.date)}
            </div>
        `;
        emailElement.addEventListener('click', () => showEmailContent(email.id));
        return emailElement;
    }
    // Email content display
    async function showEmailContent(emailId) {
        showLoadingState();
        try {
            const email = await apiRequest(ENDPOINTS.getEmail(emailId));
            populateEmailContent(email);
            // Update the email list item to show as read
            updateEmailReadStatus(emailId, true);
            emailListContainer.classList.add('hidden');
            composeEmailSection.classList.add('hidden'); // Hide compose section
            emailContentSection.classList.remove('hidden');
            loadingDiv.classList.add('hidden'); // Hide loading after content is loaded
        } catch (error) {
            showNotification('Failed to load email', 'error');
        }
    }
    function populateEmailContent(email) {
        emailSubject.textContent = email.subject || '(No Subject)';
        emailFrom.textContent = email.sender || email.from || 'Unknown';
        emailTo.textContent = currentEmailAddress || email.to || 'Unknown';
        emailDate.textContent = formatFullDate(email.date);
        // Handle email body content - use innerHTML to preserve formatting
        const bodyContent = email.body || email.text_body || '';
        emailText.innerHTML = escapeHtml(bodyContent);
        // Handle HTML content if available
        const htmlBody = email.html_body || '';
        emailHtml.innerHTML = htmlBody;
        emailHtml.classList.toggle('hidden', !htmlBody);
        // Handle attachments
        displayAttachments(email.attachments || []);
    }
    function displayAttachments(attachments) {
        if (!attachments || attachments.length === 0) {
            emailAttachments.classList.add('hidden');
            attachmentsCount.classList.add('hidden');
            return;
        }
        attachmentsCount.classList.remove('hidden');
        attachmentCountSpan.textContent = attachments.length;
        emailAttachments.classList.remove('hidden');
        attachmentsList.innerHTML = '';
        attachments.forEach((attachment, index) => {
            const attachmentElement = createAttachmentElement(attachment, index);
            attachmentsList.appendChild(attachmentElement);
        });
    }
    function createAttachmentElement(attachment, index) {
        const attachmentDiv = document.createElement('div');
        attachmentDiv.className = 'attachment-item';
        // Create download link
        const blob = new Blob([attachment.content], { type: 'text/plain' });
        const downloadUrl = URL.createObjectURL(blob);
        attachmentDiv.innerHTML = `
            <div class="attachment-header">
                <span class="attachment-name" title="${escapeHtml(attachment.filename)}">
                    📎 ${escapeHtml(attachment.filename)}
                </span>
                <div class="attachment-actions">
                    <span class="attachment-type">
                        ${escapeHtml(attachment.content_type || 'text/plain')}
                    </span>
                    <a href="${downloadUrl}" download="${escapeHtml(attachment.filename)}" class="btn small download-btn">
                        Download
                    </a>
                </div>
            </div>
            <div class="attachment-content" id="attachment-${index}">
                ${escapeHtml(attachment.content)}
            </div>
        `;
        // Clean up blob URL when attachment is removed
        attachmentDiv.addEventListener('DOMNodeRemoved', () => {
            URL.revokeObjectURL(downloadUrl);
        });
        return attachmentDiv;
    }
    // Email composition and sending
    function showComposeForm() {
        emailListContainer.classList.add('hidden');
        emailContentSection.classList.add('hidden');
        composeEmailSection.classList.remove('hidden');
        // Reset form fields
        composeToInput.value = '';
        composeSubjectInput.value = '';
        composeBodyTextarea.value = '';
        sendPaymentPendingDiv.classList.add('hidden'); // Hide payment section initially
        sendEmailBtn.classList.remove('hidden'); // Show send button
        sendEmailBtn.disabled = false;
        sendEmailBtn.textContent = 'Send Email';
        // Reset send status text and styles
        sendStatusText.textContent = '';
        sendStatusText.classList.remove('status-success', 'status-error');
        sendWeblnPayBtn.classList.add('hidden'); // Hide WebLN button
        sendLoader.classList.add('hidden'); // Hide loader
    }
    function cancelCompose() {
        composeEmailSection.classList.add('hidden');
        sendPaymentPendingDiv.classList.add('hidden');
        showEmailList(); // Go back to inbox list
        // Clear any pending payment interval
        if (sendCheckInterval) {
            clearInterval(sendCheckInterval);
            sendCheckInterval = null;
        }
        sessionStorage.removeItem(STORAGE_KEYS.sendPaymentData);
    }
    async function handleSendEmail() {
        const recipient = composeToInput.value.trim();
        const subject = composeSubjectInput.value.trim();
        const body = composeBodyTextarea.value.trim();
        if (!recipient || !body) {
            showNotification('Recipient and message body cannot be empty.', 'error');
            return;
        }
        if (!isValidEmail(recipient)) {
            showNotification('Please enter a valid recipient email address.', 'error');
            return;
        }
        try {
            sendEmailBtn.disabled = true;
            sendEmailBtn.textContent = 'Generating Invoice...';
            // Update status text in the payment section (which will be shown next)
            sendStatusText.textContent = 'Generating Lightning invoice...';
            sendStatusText.classList.remove('status-success', 'status-error');
            sendLoader.classList.remove('hidden');
            sendPaymentPendingDiv.classList.remove('hidden'); // Show payment section early
            sendWeblnPayBtn.classList.add('hidden'); // Hide WebLN button initially

            const response = await apiRequest(ENDPOINTS.sendEmail, {
                method: 'POST',
                body: JSON.stringify({ recipient, subject, body })
            });

            // Store invoice data in session storage
            const paymentData = {
                payment_hash: response.payment_hash,
                payment_request: response.payment_request,
                price_sats: response.price_sats,
                recipient: recipient,
                subject: subject,
                body: body,
                created_at: new Date().toISOString()
            };
            sessionStorage.setItem(STORAGE_KEYS.sendPaymentData, JSON.stringify(paymentData));
            displaySendPaymentScreen(paymentData);

            // WebLN integration
            if (window.webln) {
                sendWeblnPayBtn.classList.remove('hidden');
                sendWeblnPayBtn.onclick = async () => {
                    try {
                        await window.webln.enable();
                        await window.webln.sendPayment(sendBolt11Invoice.textContent);
                        showNotification('WebLN payment initiated. Checking status...', 'info');
                        checkSendPaymentStatus(); // Check status immediately after WebLN pay
                    } catch (error) {
                        showNotification(`WebLN payment failed: ${error.message}`, 'error');
                    }
                };
            }
            currentSendPaymentHash = response.payment_hash;
            sendCheckInterval = setInterval(checkSendPaymentStatus, 3000);
        } catch (error) {
            console.error('Error sending email:', error);
            showNotification(`Failed to send email: ${error.message}`, 'error');
            sendEmailBtn.disabled = false;
            sendEmailBtn.textContent = 'Send Email';
            sendPaymentPendingDiv.classList.add('hidden'); // Hide payment section on error
            sendStatusText.textContent = ''; // Clear status text on error
            sendLoader.classList.add('hidden');
        }
    }
    function displaySendPaymentScreen(paymentData) {
        sendEmailBtn.classList.add('hidden'); // Hide send button
        sendPaymentPendingDiv.classList.remove('hidden');
        sendBolt11Invoice.textContent = paymentData.payment_request;
        sendInvoiceAmount.textContent = `Amount: ${paymentData.price_sats} sats`;
        sendStatusText.textContent = 'Waiting for Lightning payment...';
        sendStatusText.classList.remove('status-success', 'status-error');
        sendLoader.classList.remove('hidden');
        sendQrContainer.innerHTML = '';
        const canvas = document.createElement('canvas');
        sendQrContainer.appendChild(canvas);
        new QRious({
            element: canvas,
            value: paymentData.payment_request,
            size: 200,
            level: 'H'
        });
    }
    async function checkSendPaymentStatus() {
        if (!currentSendPaymentHash) return;
        try {
            const response = await apiRequest(ENDPOINTS.sendPaymentStatus(currentSendPaymentHash));
            if (response.payment_status === 'paid') {
                clearInterval(sendCheckInterval);
                sendCheckInterval = null;
                sessionStorage.removeItem(STORAGE_KEYS.sendPaymentData);
                handleSendPaymentSuccess();
            } else if (response.payment_status === 'failed' || response.payment_status === 'expired') {
                clearInterval(sendCheckInterval);
                sendCheckInterval = null;
                sessionStorage.removeItem(STORAGE_KEYS.sendPaymentData);
                handleSendPaymentFailure(response.payment_status);
            }
        } catch (error) {
            console.error('Error checking send payment status:', error);
            // Keep retrying on error
        }
    }
    function handleSendPaymentSuccess() {
        showNotification('Email sent successfully!', 'success');
        sendLoader.classList.add('hidden');
        sendWeblnPayBtn.classList.add('hidden');
        sendStatusText.textContent = 'Email sent successfully! Redirecting to inbox...';
        sendStatusText.classList.remove('status-error');
        sendStatusText.classList.add('status-success');
        // Hide invoice, QR, and copy button after successful payment
        sendBolt11Invoice.parentElement.classList.add('hidden');
        sendInvoiceAmount.classList.add('hidden');
        sendQrContainer.classList.add('hidden');
        sendCopyInvoiceBtn.classList.add('hidden');
        cancelSendPaymentBtn.classList.add('hidden');

        setTimeout(() => {
            sendPaymentPendingDiv.classList.add('hidden'); // Hide payment section
            showEmailList(); // Go back to inbox
            // Reset status text and styles for next use
            sendStatusText.textContent = '';
            sendStatusText.classList.remove('status-success', 'status-error');
            sendBolt11Invoice.parentElement.classList.remove('hidden');
            sendInvoiceAmount.classList.remove('hidden');
            sendQrContainer.classList.remove('hidden');
            sendCopyInvoiceBtn.classList.remove('hidden');
            cancelSendPaymentBtn.classList.remove('hidden');
        }, 2000); // 2-second delay
    }

    function handleSendPaymentFailure(status) {
        showNotification(`Email payment ${status}. Please try again.`, 'error');
        sendLoader.classList.add('hidden');
        sendWeblnPayBtn.classList.add('hidden');
        sendStatusText.textContent = `Email payment ${status}. Please try again.`;
        sendStatusText.classList.remove('status-success');
        sendStatusText.classList.add('status-error');
        // Re-enable send button on failure to allow retry
        sendEmailBtn.disabled = false;
        sendEmailBtn.textContent = 'Send Email';

        setTimeout(() => {
            cancelSendPayment(); // Reset UI to compose form
            sendStatusText.classList.remove('status-error');
            sendStatusText.textContent = ''; // Clear status text after returning to compose
        }, 3000); // 3-second delay
    }

    function cancelSendPayment() {
        if (sendCheckInterval) {
            clearInterval(sendCheckInterval);
            sendCheckInterval = null;
        }
        sessionStorage.removeItem(STORAGE_KEYS.sendPaymentData);
        sendPaymentPendingDiv.classList.add('hidden');
        sendEmailBtn.classList.remove('hidden');
        sendEmailBtn.disabled = false;
        sendEmailBtn.textContent = 'Send Email';
        // Go back to the compose form or inbox
        showComposeForm(); // Show compose form, which also resets its state
    }
    // Utility functions
    function updateEmailReadStatus(emailId, isRead) {
        // Update in stored data
        const emailIndex = emailsData.findIndex(email => email.id === emailId);
        if (emailIndex !== -1) {
            emailsData[emailIndex].read = isRead;
        }
        // Update UI - find the email item and update its class
        const emailItems = document.querySelectorAll('.email-list-item');
        emailItems.forEach(item => {
            // Check if this is the right email item by looking for the email ID
            // Since we don't store the ID directly, we'll refresh the list
        });
        // For now, just refresh the email list to reflect the updated read status
        // In a more sophisticated implementation, we could store the email ID as a data attribute
        setTimeout(() => {
            renderEmails(emailsData);
        }, 100);
    }
    function truncateText(text, maxLength) {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    function isValidEmail(email) {
        // Basic email validation regex
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    function formatDate(dateStr) {
        if (!dateStr) return 'Unknown';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const emailDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            if (emailDate.getTime() === today.getTime()) {
                return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } else if (emailDate.getTime() === today.getTime() - 86400000) {
                return 'Yesterday';
            } else if (date.getFullYear() === now.getFullYear()) {
                return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
            } else {
                return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
            }
        } catch (error) {
            return 'Invalid Date';
        }
    }
    function formatFullDate(dateStr) {
        if (!dateStr) return 'Unknown';
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString([], {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (error) {
            return 'Invalid Date';
        }
    }
    // Navigation and state management
    function showEmailList() {
        emailContentSection.classList.add('hidden');
        composeEmailSection.classList.add('hidden'); // Hide compose section
        emailListContainer.classList.remove('hidden');
        // Refresh emails to show updated read statuses
        fetchEmails();
    }
    function handleLogout() {
        localStorage.removeItem(STORAGE_KEYS.accessToken);
        localStorage.removeItem(STORAGE_KEYS.emailAddress);
        sessionStorage.removeItem(STORAGE_KEYS.sendPaymentData); // Clear send payment data on logout
        window.location.href = '/';
    }
    function showLoadingState() {
        loadingDiv.classList.remove('hidden');
        noEmailsDiv.classList.add('hidden');
        if (emailList) {
            emailList.innerHTML = '';
        }
    }
    function handleEmailFetchError(error) {
        console.error('Email fetch error:', error);
        showNotification('Failed to load emails', 'error');
        loadingDiv.classList.add('hidden');
        noEmailsDiv.classList.remove('hidden');
    }
    function startAutoRefresh() {
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
        autoRefreshInterval = setInterval(fetchEmails, 30000); // Refresh every 30 seconds
    }
    // Initialize
    addResetButton();
    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
        if (sendCheckInterval) clearInterval(sendCheckInterval);
        // Clean up any blob URLs
        document.querySelectorAll('.download-btn').forEach(btn => {
            if (btn.href && btn.href.startsWith('blob:')) {
                URL.revokeObjectURL(btn.href);
            }
        });
    });
});
