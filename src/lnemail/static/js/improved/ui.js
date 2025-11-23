import { state } from './state.js';
import { ITEMS_PER_PAGE } from './config.js';
import { fetchEmailContent } from './api.js';
import { escapeHtml, getFileIcon, isTextFile, isValidBase64 } from './utils.js';
import { openEmail } from './inbox.js';

export function showStatus(message, type = 'info') {
    const statusContainer = document.getElementById('statusContainer');
    const statusDiv = document.createElement('div');
    statusDiv.className = `status-message ${type}`;

    const icon = type === 'success' ? 'check-circle' :
                type === 'error' ? 'exclamation-circle' :
                'info-circle';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'status-close-btn';
    closeBtn.setAttribute('aria-label', 'Close notification');
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';

    // Progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'status-progress-bar';

    statusDiv.innerHTML = `<i class="fas fa-${icon}"></i> <span class="status-message-text">${message}</span>`;
    statusDiv.appendChild(closeBtn);
    statusDiv.appendChild(progressBar);
    statusContainer.appendChild(statusDiv);

    // Animate progress bar
    const duration = 5000;

    // Use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
        progressBar.style.transition = `width ${duration}ms linear`;
        requestAnimationFrame(() => {
            progressBar.style.width = '100%';
        });
    });

    // Auto-remove after duration
    const timeoutId = setTimeout(() => {
        if (statusDiv.parentNode) {
            statusDiv.parentNode.removeChild(statusDiv);
        }
    }, duration);

    // Manual close
    closeBtn.addEventListener('click', () => {
        clearTimeout(timeoutId);
        if (statusDiv.parentNode) {
            statusDiv.parentNode.removeChild(statusDiv);
        }
    });
}

export function showTokenModal() {
    document.getElementById('tokenModal').classList.add('active');
    document.getElementById('accessToken').focus();
}

export function hideTokenModal() {
    document.getElementById('tokenModal').classList.remove('active');
}

export function showMainApp() {
    document.getElementById('mainApp').classList.add('active');
}

export function hideMainApp() {
    document.getElementById('mainApp').classList.remove('active');
}

export function updateAccountDisplay() {
    if (state.accountInfo) {
        document.getElementById('accountEmail').textContent = state.accountInfo.email_address;

        const expiryDate = new Date(state.accountInfo.expires_at);
        const now = new Date();
        const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

        let relativeText;
        if (daysUntilExpiry > 1) relativeText = `Expires in ${daysUntilExpiry} days`;
        else if (daysUntilExpiry === 1) relativeText = 'Expires tomorrow';
        else if (daysUntilExpiry === 0) relativeText = 'Expires today';
        else relativeText = 'Expired';

        const exactDate = expiryDate.toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        const fullExpiryText = `${relativeText} (${exactDate})`;

        document.getElementById('accountExpiry').textContent = fullExpiryText;
        document.getElementById('accountExpiry').title = `Full expiry: ${expiryDate.toLocaleString()}`;
    }
}

export function showView(viewName) {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.querySelector(`[data-view="${viewName}"]`)?.classList.add('active');

    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));

    const targetView = document.getElementById(`${viewName}View`);
    if (targetView) {
        targetView.classList.add('active');
        state.currentView = viewName;
    }
}

export function renderEmailList() {
    const emailList = document.getElementById('emailList');

    if (state.emails.length === 0) {
        renderEmptyInbox();
        return;
    }

    // Clean up any selections for emails that no longer exist
    cleanupSelectedEmails();

    const totalPages = Math.ceil(state.emails.length / ITEMS_PER_PAGE);

    if (state.currentPage > totalPages && totalPages > 0) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;

    const startIndex = (state.currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const paginatedEmails = state.emails.slice(startIndex, endIndex);

    const emailRows = paginatedEmails.map(email => {
        const date = new Date(email.date || email.timestamp || Date.now());
        const isToday = date.toDateString() === new Date().toDateString();
        const isThisYear = date.getFullYear() === new Date().getFullYear();

        let dateDisplay;
        if (isToday) {
            dateDisplay = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        } else if (isThisYear) {
            dateDisplay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } else {
            dateDisplay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        const senderName = (email.from || email.sender || 'Unknown Sender').replace(/<.*?>/, '').trim() || 'Unknown Sender';
        const subject = email.subject || 'No Subject';
        const isUnread = email.read === false;

        const isSelected = state.selectedEmailIds.has(email.id);

        return `
            <div class="inbox-email-row ${isUnread ? 'inbox-unread' : 'inbox-read'}" data-email-id="${email.id}">
                <div class="inbox-cell inbox-checkbox-cell">
                    <input type="checkbox" class="email-checkbox" data-email-id="${email.id}" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation()">
                </div>
                <div class="inbox-cell inbox-status-cell"><i class="fas ${isUnread ? 'fa-circle' : 'fa-envelope-open'} read-status-icon"></i></div>
                <div class="inbox-cell inbox-sender-cell">${escapeHtml(senderName)}</div>
                <div class="inbox-cell inbox-subject-cell">${escapeHtml(subject)}</div>
                <div class="inbox-cell inbox-date-cell">${dateDisplay}</div>
            </div>
        `;
    }).join('');

    emailList.innerHTML = `
        <div class="inbox-controls">
            <button id="deleteSelectedBtn" class="btn-delete" disabled>
                <i class="fas fa-trash"></i> DELETE (<span id="selectedCount">0</span>)
            </button>
        </div>
        <div class="inbox-table">
            <div class="inbox-table-header">
                <div class="inbox-header-checkbox">
                    <input type="checkbox" id="selectAllCheckbox" title="Select all">
                </div>
                <div class="inbox-header-status"></div>
                <div class="inbox-header-sender">From</div>
                <div class="inbox-header-subject">Subject</div>
                <div class="inbox-header-date">Date</div>
            </div>
            <div class="inbox-table-body">${emailRows}</div>
        </div>
        ${renderPaginationControls(totalPages)}
    `;

    emailList.querySelectorAll('.inbox-email-row').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.matches('input[type="checkbox"]')) {
                openEmail(item.dataset.emailId);
            }
        });
    });

    // Add event listeners for checkboxes
    bindCheckboxEvents();
    bindPaginationEvents();
}

function renderPaginationControls(totalPages) {
    if (totalPages <= 1) return '';

    let paginationHtml = `<div class="pagination-controls">`;
    paginationHtml += `<button class="pagination-btn" data-page="${state.currentPage - 1}" ${state.currentPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i> Prev</button>`;
    paginationHtml += `<span class="pagination-info">Page ${state.currentPage} of ${totalPages}</span>`;
    paginationHtml += `<button class="pagination-btn" data-page="${state.currentPage + 1}" ${state.currentPage === totalPages ? 'disabled' : ''}>Next <i class="fas fa-chevron-right"></i></button>`;
    paginationHtml += `</div>`;
    return paginationHtml;
}

function bindPaginationEvents() {
    document.querySelectorAll('.pagination-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            const page = parseInt(e.currentTarget.dataset.page);
            if (page) {
                state.currentPage = page;
                renderEmailList();
            }
        });
    });
}

function bindCheckboxEvents() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const emailCheckboxes = document.querySelectorAll('.email-checkbox');
    const deleteBtn = document.getElementById('deleteSelectedBtn');
    const selectedCountSpan = document.getElementById('selectedCount');

    // Handle select all checkbox
    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', () => {
            const isChecked = selectAllCheckbox.checked;
            emailCheckboxes.forEach(checkbox => {
                checkbox.checked = isChecked;
                const emailId = checkbox.dataset.emailId;
                if (isChecked) {
                    state.selectedEmailIds.add(emailId);
                } else {
                    state.selectedEmailIds.delete(emailId);
                }
            });
            updateDeleteButtonState();
        });
    }

    // Handle individual email checkboxes
    emailCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const emailId = checkbox.dataset.emailId;
            if (checkbox.checked) {
                state.selectedEmailIds.add(emailId);
            } else {
                state.selectedEmailIds.delete(emailId);
            }
            updateSelectAllState();
            updateDeleteButtonState();
        });
    });

    // Initialize states based on current selections
    updateSelectAllState();
    updateDeleteButtonState();

    function updateSelectAllState() {
        const checkedCount = document.querySelectorAll('.email-checkbox:checked').length;
        const totalCount = emailCheckboxes.length;

        if (selectAllCheckbox) {
            selectAllCheckbox.checked = checkedCount === totalCount && totalCount > 0;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < totalCount;
        }
    }

    function updateDeleteButtonState() {
        const checkedCount = state.selectedEmailIds.size;

        if (deleteBtn && selectedCountSpan) {
            selectedCountSpan.textContent = checkedCount;
            deleteBtn.disabled = checkedCount === 0;

            if (checkedCount === 0) {
                deleteBtn.innerHTML = '<i class="fas fa-trash"></i> DELETE (<span id="selectedCount">0</span>)';
            } else {
                deleteBtn.innerHTML = `<i class="fas fa-trash"></i> DELETE (<span id="selectedCount">${checkedCount}</span>)`;
            }
        }
    }
}

export function getSelectedEmailIds() {
    return Array.from(state.selectedEmailIds);
}

export function clearSelectedEmails() {
    state.selectedEmailIds.clear();
}

function cleanupSelectedEmails() {
    // Remove any selected email IDs that no longer exist in the current email list
    const currentEmailIds = new Set(state.emails.map(email => email.id));
    const toRemove = [];

    for (const selectedId of state.selectedEmailIds) {
        if (!currentEmailIds.has(selectedId)) {
            toRemove.push(selectedId);
        }
    }

    toRemove.forEach(id => state.selectedEmailIds.delete(id));
}

function renderEmptyInbox() {
    document.getElementById('emailList').innerHTML = `
        <div class="empty-state">
            <i class="fas fa-inbox"></i>
            <h3>No emails found</h3>
            <p>Your inbox is empty or there was an issue loading your emails.<br>Try refreshing or check your connection.</p>
        </div>
    `;
}

export function updateInboxCount() {
    const count = state.emails.filter(email => email.read === false).length;
    document.getElementById('inboxCount').textContent = count;
}

export function displayEmailAttachments(attachments) {
    const attachmentsContainer = document.getElementById('emailAttachments');

    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
        attachmentsContainer.innerHTML = '';
        return;
    }

    state.currentAttachments = attachments;

    const attachmentsList = attachments.map((attachment, index) => {
        const filename = attachment.filename || `Attachment ${index + 1}`;
        const hasContent = attachment.content && attachment.content.length > 0;
        const contentSize = hasContent ? Math.round(attachment.content.length / 1024) : 0;
        const contentType = getFileIcon(filename);
        const isText = isTextFile(filename);

        return `
            <div class="attachment-detail" data-attachment-index="${index}">
                <div class="attachment-info">
                    <i class="fas ${contentType.icon}"></i>
                    <span class="attachment-name">${escapeHtml(filename)}</span>
                    ${hasContent ? `<span class="attachment-size">(${contentSize}KB)</span>` : ''}
                </div>
                <div class="attachment-actions">
                    ${hasContent ? `
                        <button class="btn-small attachment-download-btn"><i class="fas fa-download"></i> Download</button>
                        ${isText ? `<button class="btn-small attachment-preview-btn"><i class="fas fa-eye"></i> Preview</button>` : `<span class="attachment-note">Preview not available</span>`}
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');

    attachmentsContainer.innerHTML = `
        <div class="attachments-section">
            <h4><i class="fas fa-paperclip"></i> Attachments (${attachments.length})</h4>
            <div class="attachments-list-detail">${attachmentsList}</div>
        </div>
    `;

    attachmentsContainer.querySelectorAll('.attachment-download-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.closest('.attachment-detail').dataset.attachmentIndex);
            downloadAttachment(index);
        });
    });

    attachmentsContainer.querySelectorAll('.attachment-preview-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.closest('.attachment-detail').dataset.attachmentIndex);
            previewAttachment(index);
        });
    });
}

function downloadAttachment(index) {
    const attachment = state.currentAttachments[index];
    if (!attachment) return;

    try {
        if (!attachment.content || attachment.content.trim() === '') {
            showStatus(`No content available for ${attachment.filename}`, 'error');
            return;
        }

        let blob;
        if (isTextFile(attachment.filename) && !isValidBase64(attachment.content)) {
            blob = new Blob([attachment.content], { type: 'text/plain' });
        } else {
            const binaryString = atob(attachment.content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            blob = new Blob([bytes]);
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = attachment.filename;
        document.body.appendChild(a);
a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showStatus(`Downloaded ${attachment.filename}`, 'success');
    } catch (error) {
        // console.error('Failed to download attachment:', error);
        showStatus(`Failed to download ${attachment.filename}: ${error.message}`, 'error');
    }
}

function previewAttachment(index) {
    const attachment = state.currentAttachments[index];
    if (!attachment) return;

    try {
        if (!attachment.content || attachment.content.trim() === '') {
            showStatus(`No content available for ${attachment.filename}`, 'error');
            return;
        }

        const textContent = isValidBase64(attachment.content) ? atob(attachment.content) : attachment.content;
        const modalContent = `<textarea disabled class="preview-textarea">${escapeHtml(textContent)}</textarea>`;

        const modal = document.createElement('div');
        modal.className = 'preview-modal';
        modal.innerHTML = `
            <div class="preview-content">
                <div class="preview-header">
                    <h3>${escapeHtml(attachment.filename)}</h3>
                    <button class="close-preview">&times;</button>
                </div>
                <div class="preview-body">
                    ${modalContent}
                </div>
                <div class="preview-actions">
                    <button class="btn-small preview-download-btn"><i class="fas fa-download"></i> Download</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeModal = () => document.body.removeChild(modal);

        modal.querySelector('.preview-download-btn').addEventListener('click', () => downloadAttachment(index));
        modal.querySelector('.close-preview').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    } catch (error) {
        showStatus(`Failed to preview ${attachment.filename}: ${error.message}`, 'error');
    }
}

export function clearComposeForm() {
    document.getElementById('recipient').value = '';
    document.getElementById('subject').value = '';
    document.getElementById('body').value = '';
}

export function updateHealthStatus(healthData) {
    const healthIcon = document.getElementById('healthIcon');
    const healthStatus = document.getElementById('healthStatus');
    const healthStatusValue = document.getElementById('healthStatusValue');
    const healthVersionValue = document.getElementById('healthVersionValue');
    const healthTimestampValue = document.getElementById('healthTimestampValue');

    if (healthData.success && healthData.data) {
        // Update header indicator
        healthIcon.className = 'fas fa-check-circle';
        healthIcon.style.color = '#28a745'; // Green color
        healthStatus.textContent = 'API Status: Online';

        // Update detailed status
        healthStatusValue.textContent = healthData.data.status || 'OK';
        healthStatusValue.style.color = '#28a745';
        healthVersionValue.textContent = healthData.data.version || 'Unknown';

        // Format timestamp
        if (healthData.data.timestamp) {
            const timestamp = new Date(healthData.data.timestamp);
            healthTimestampValue.textContent = timestamp.toLocaleString();
        } else {
            healthTimestampValue.textContent = new Date().toLocaleString();
        }
    } else {
        // Update header indicator for error
        healthIcon.className = 'fas fa-exclamation-circle';
        healthIcon.style.color = '#dc3545'; // Red color
        healthStatus.textContent = 'API Status: Error';

        // Update detailed status for error
        healthStatusValue.textContent = 'Error';
        healthStatusValue.style.color = '#dc3545';
        healthVersionValue.textContent = '-';
        healthTimestampValue.textContent = new Date().toLocaleString();

        // Show error message
        if (healthData.error) {
            showStatus(`Health check failed: ${healthData.error}`, 'error');
        }
    }
}

export function updateHealthStatusLoading() {
    const healthIcon = document.getElementById('healthIcon');
    const healthStatus = document.getElementById('healthStatus');
    const healthStatusValue = document.getElementById('healthStatusValue');

    // Update header indicator
    healthIcon.className = 'fas fa-spinner fa-spin';
    healthIcon.style.color = '#ffc107'; // Yellow color
    healthStatus.textContent = 'API Status: Checking...';

    // Update detailed status
    healthStatusValue.textContent = 'Checking...';
    healthStatusValue.style.color = '#ffc107';
}

// Login page health status functions
export function updateLoginHealthStatus(healthData) {
    const loginHealthIcon = document.getElementById('loginHealthIcon');
    const loginHealthStatus = document.getElementById('loginHealthStatus');
    const loginHealthStatusValue = document.getElementById('loginHealthStatusValue');
    const loginHealthVersionValue = document.getElementById('loginHealthVersionValue');
    const loginHealthTimestampValue = document.getElementById('loginHealthTimestampValue');

    if (healthData.success && healthData.data) {
        // Update login health indicator
        loginHealthIcon.className = 'fas fa-check-circle';
        loginHealthIcon.style.color = '#28a745'; // Green color
        loginHealthStatus.textContent = 'API Status: Online';

        // Update detailed status
        loginHealthStatusValue.textContent = healthData.data.status || 'OK';
        loginHealthStatusValue.style.color = '#28a745';
        loginHealthVersionValue.textContent = healthData.data.version || 'Unknown';

        // Format timestamp
        if (healthData.data.timestamp) {
            const timestamp = new Date(healthData.data.timestamp);
            loginHealthTimestampValue.textContent = timestamp.toLocaleString();
        } else {
            loginHealthTimestampValue.textContent = new Date().toLocaleString();
        }
    } else {
        // Update login health indicator for error
        loginHealthIcon.className = 'fas fa-exclamation-circle';
        loginHealthIcon.style.color = '#dc3545'; // Red color
        loginHealthStatus.textContent = 'API Status: Error';

        // Update detailed status for error
        loginHealthStatusValue.textContent = 'Error';
        loginHealthStatusValue.style.color = '#dc3545';
        loginHealthVersionValue.textContent = '-';
        loginHealthTimestampValue.textContent = new Date().toLocaleString();
    }

    // Update connect button state based on health status
    updateConnectButtonState(healthData.success);
}

export function updateLoginHealthStatusLoading() {
    const loginHealthIcon = document.getElementById('loginHealthIcon');
    const loginHealthStatus = document.getElementById('loginHealthStatus');
    const loginHealthStatusValue = document.getElementById('loginHealthStatusValue');

    // Update login health indicator
    loginHealthIcon.className = 'fas fa-spinner fa-spin';
    loginHealthIcon.style.color = '#ffc107'; // Yellow color
    loginHealthStatus.textContent = 'API Status: Checking...';

    // Update detailed status
    loginHealthStatusValue.textContent = 'Checking...';
    loginHealthStatusValue.style.color = '#ffc107';

    // Disable connect button while checking
    updateConnectButtonState(false);
}

export function updateConnectButtonState(isHealthy) {
    const connectBtn = document.getElementById('connectBtn');
    const accessToken = document.getElementById('accessToken');

    if (isHealthy) {
        connectBtn.disabled = false;
        connectBtn.title = '';
        connectBtn.style.opacity = '1';
    } else {
        connectBtn.disabled = true;
        connectBtn.title = 'API health check must pass before authentication';
        connectBtn.style.opacity = '0.6';
    }
}

export function showPaymentModal() {
    document.getElementById('paymentModal').classList.add('active');
}

export function hidePaymentModal() {
    document.getElementById('paymentModal').classList.remove('active');
}

export function updatePaymentModal(invoiceData) {
    document.getElementById('paymentRecipient').textContent = invoiceData.recipient;
    document.getElementById('paymentSubject').textContent = invoiceData.subject;
    document.getElementById('paymentAmount').textContent = `${invoiceData.price_sats} sats`;
    document.getElementById('paymentHashValue').textContent = invoiceData.payment_hash;

    // Check for WebLN availability
    const weblnBtn = document.getElementById('weblnPayBtn');
    if (weblnBtn) {
        if (window.webln) {
            weblnBtn.style.display = '';
        } else {
            weblnBtn.style.display = 'none';
        }
    }

    // Set loading state for QR code
    const qrContainer = document.querySelector('.qr-code-container');
    qrContainer.innerHTML = `
        <div class="qr-loader">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Generating QR Code...</p>
        </div>
    `;

    // Generate QR code with library availability check
    generateQRCode(invoiceData.payment_request);
}

async function waitForQRCodeLibrary() {
    return new Promise((resolve, reject) => {
        if (typeof QRious !== 'undefined') {
            resolve();
            return;
        }

        let attempts = 0;
        const maxAttempts = 100; // 5 seconds total

        // Poll for library availability
        const checkInterval = setInterval(() => {
            attempts++;
            if (typeof QRious !== 'undefined') {
                clearInterval(checkInterval);
                resolve();
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                reject(new Error('QRious library failed to load within timeout'));
            }
        }, 50); // Check every 50ms
    });
}

async function generateQRCode(paymentRequest) {
    try {
        await waitForQRCodeLibrary();

        if (typeof QRious === 'undefined') {
            throw new Error('QRious library failed to load');
        }

        const qrContainer = document.querySelector('.qr-code-container');
        qrContainer.innerHTML = ''; // Clear loader

        // Create canvas for QRious
        const canvas = document.createElement('canvas');
        qrContainer.appendChild(canvas);

        new QRious({
            element: canvas,
            value: paymentRequest,
            size: 200,
            level: 'H'
        });

    } catch (error) {
        // console.error('QR Code library error:', error);
        showStatus('QR code library unavailable, showing text invoice', 'warning');
        showFallbackQRCode(paymentRequest);
    }
}

function showFallbackQRCode(paymentRequest) {
    // Fallback: show the invoice as text if QR code fails
    const container = document.querySelector('.qr-code-container');
    if (!container) return;

    container.innerHTML = `
        <div class="qr-fallback-box">
            <i class="fas fa-qrcode qr-fallback-icon"></i>
            <p class="qr-fallback-title">QR Code Unavailable</p>
            <p class="qr-fallback-desc">Please copy the invoice manually:</p>
            <textarea readonly class="qr-fallback-textarea">${paymentRequest}</textarea>
        </div>
    `;
}

export function updatePaymentStatus(status, message) {
    const statusContainer = document.querySelector('.payment-status');
    const statusIcon = document.getElementById('paymentStatusIcon');
    const statusText = document.getElementById('paymentStatusText');

    statusContainer.className = 'payment-status';

    switch (status) {
        case 'pending':
            statusContainer.classList.add('pending');
            statusIcon.className = 'fas fa-circle-notch fa-spin';
            statusIcon.style.color = '#ffc107';
            statusText.textContent = message || 'Waiting for payment...';
            break;
        case 'success':
            statusContainer.classList.add('success');
            statusIcon.className = 'fas fa-check-circle';
            statusIcon.style.color = '#28a745';
            statusText.textContent = message || 'Payment confirmed!';
            break;
        case 'error':
            statusContainer.classList.add('error');
            statusIcon.className = 'fas fa-exclamation-circle';
            statusIcon.style.color = '#dc3545';
            statusText.textContent = message || 'Payment failed';
            break;
        default:
            statusIcon.className = 'fas fa-circle-notch fa-spin';
            statusIcon.style.color = '#ffc107';
            statusText.textContent = message || 'Checking payment status...';
    }
}

export function showAccountCreationModal() {
    document.getElementById('accountCreationModal').classList.add('active');
}

export function hideAccountCreationModal() {
    document.getElementById('accountCreationModal').classList.remove('active');
}

export function updateAccountCreationModal(accountData) {
    document.getElementById('accountEmailAddress').textContent = accountData.email_address;
    document.getElementById('accountAccessTokenText').textContent = accountData.access_token;
    document.getElementById('accountAmount').textContent = `${accountData.price_sats} sats`;
    document.getElementById('accountPaymentHashValue').textContent = accountData.payment_hash;

    // Check for WebLN availability
    const weblnBtn = document.getElementById('accountWeblnPayBtn');
    if (weblnBtn) {
        if (window.webln) {
            weblnBtn.style.display = '';
        } else {
            weblnBtn.style.display = 'none';
        }
    }

    // Set loading state for QR code
    const qrContainer = document.querySelector('#accountCreationModal .qr-code-container');
    qrContainer.innerHTML = `
        <div class="qr-loader">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Generating QR Code...</p>
        </div>
    `;

    // Generate QR code with library availability check
    generateAccountQRCode(accountData.payment_request);
}

async function generateAccountQRCode(paymentRequest) {
    try {
        await waitForQRCodeLibrary();

        if (typeof QRious === 'undefined') {
            throw new Error('QRious library failed to load');
        }

        const qrContainer = document.querySelector('#accountCreationModal .qr-code-container');

        // Clear container
        qrContainer.innerHTML = '';

        // Create canvas for QRious
        const canvas = document.createElement('canvas');
        qrContainer.appendChild(canvas);

        new QRious({
            element: canvas,
            value: paymentRequest,
            size: 200,
            level: 'H'
        });

    } catch (error) {
        // console.error('Account QR Code library error:', error);
        showStatus('QR code library unavailable, showing text invoice', 'warning');
        showAccountFallbackQRCode(paymentRequest);
    }
}

function showAccountFallbackQRCode(paymentRequest) {
    // Fallback: show the invoice as text if QR code fails
    const container = document.querySelector('#accountCreationModal .qr-code-container');
    container.innerHTML = `
        <div class="qr-fallback-box">
            <i class="fas fa-qrcode qr-fallback-icon"></i>
            <p class="qr-fallback-title">QR Code Unavailable</p>
            <p class="qr-fallback-desc">Please copy the invoice manually:</p>
            <textarea readonly class="qr-fallback-textarea">${paymentRequest}</textarea>
        </div>
    `;
}

export function updateAccountPaymentStatus(status, message) {
    const statusIcon = document.getElementById('accountPaymentStatusIcon');
    const statusText = document.getElementById('accountPaymentStatusText');

    statusText.textContent = message;

    // Remove existing status classes
    statusIcon.className = statusIcon.className.replace(/fa-(check-circle|exclamation-circle|circle-notch|spin)/g, '');

    switch (status) {
        case 'pending':
            statusIcon.classList.add('fa-circle-notch', 'fa-spin');
            statusIcon.style.color = '#ffc107';
            break;
        case 'success':
            statusIcon.classList.add('fa-check-circle');
            statusIcon.style.color = '#28a745';
            break;
        case 'error':
            statusIcon.classList.add('fa-exclamation-circle');
            statusIcon.style.color = '#dc3545';
            break;
    }
}

export function updatePaymentModalWithDelivery(statusResponse) {
    // First handle the basic payment status
    if (statusResponse.payment_status === 'pending') {
        updatePaymentStatus('pending', 'Waiting for payment...');
        return;
    } else if (statusResponse.payment_status === 'expired') {
        updatePaymentStatus('error', 'Payment expired. Please try again.');
        return;
    } else if (statusResponse.payment_status === 'failed') {
        updatePaymentStatus('error', 'Payment failed.');
        return;
    }

    // Payment is paid, check delivery status
    if (statusResponse.payment_status === 'paid') {
        if (statusResponse.delivery_status === 'sent') {
            updatePaymentStatus('success', 'Payment confirmed! Email delivered.');
        } else if (statusResponse.delivery_status === 'failed') {
            const errorMsg = statusResponse.delivery_error ? `Delivery failed: ${statusResponse.delivery_error}` : 'Delivery failed';
            updatePaymentStatus('error', errorMsg);
        } else {
            // Delivery pending
            const retryCount = statusResponse.retry_count || 0;
            const msg = retryCount > 0 ? `Sending email (Retry ${retryCount})...` : 'Payment confirmed! Sending email...';
            // We use 'success' style for the payment confirmation, but maybe with a spinner for delivery?
            updatePaymentStatus('success', msg);

            // Optionally override the icon to be a spinner if we want to show it's still working
            const statusIcon = document.getElementById('paymentStatusIcon');
            if (statusIcon) {
                statusIcon.className = 'fas fa-spinner fa-spin';
                statusIcon.style.color = '#28a745';
            }
        }
    }
}

export function renderRecentSends() {
    const container = document.getElementById('recentSendsList');
    if (!container) return;

    if (!state.recentSends || state.recentSends.length === 0) {
        container.innerHTML = '<div class="empty-state-small">No recent emails sent</div>';
        return;
    }

    const html = state.recentSends.map(send => {
        const date = new Date(send.created_at).toLocaleDateString();
        let statusIcon = 'clock';
        let statusClass = 'pending';

        if (send.delivery_status === 'sent') {
            statusIcon = 'check-circle';
            statusClass = 'success';
        } else if (send.delivery_status === 'failed') {
            statusIcon = 'exclamation-circle';
            statusClass = 'error';
        }

        return `
            <div class="recent-send-item">
                <div class="send-details">
                    <span class="send-recipient">${escapeHtml(send.recipient)}</span>
                    <span class="send-subject">${escapeHtml(send.subject)}</span>
                </div>
                <div class="send-meta">
                    <span class="send-date">${date}</span>
                    <span class="send-status ${statusClass}" title="${send.delivery_status}">
                        <i class="fas fa-${statusIcon}"></i>
                    </span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

export function initMobileMenu() {
    // Mobile menu toggle functionality
    const mobileToggle = document.querySelector('.mobile-menu-toggle');
    if (mobileToggle) {
        mobileToggle.addEventListener('click', function() {
            const nav = document.querySelector('.header-nav');
            nav.classList.toggle('active');

            // Change toggle icon based on menu state
            if (nav.classList.contains('active')) {
                mobileToggle.innerHTML = '&times;';  // × symbol
            } else {
                mobileToggle.innerHTML = '&#9776;';  // ≡ symbol
            }
        });
    }

    // Mark active page in navigation
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.header-nav .nav-link');

    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPath ||
            (href !== '/' && currentPath.startsWith(href))) {
            link.classList.add('active');
        }
    });
}
