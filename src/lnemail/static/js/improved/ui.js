import { state } from './state.js';
import { ITEMS_PER_PAGE, RENEWAL_PRICE_PER_YEAR, RENEWAL_WARNING_DAYS } from './config.js';
import { fetchEmailContent } from './api.js';
import { escapeHtml, getFileIcon, isTextFile, formatFileSize, formatDateDMY, formatDateTime24 } from './utils.js';
import { openEmail, renderEmailBodyContent } from './inbox.js';

export function showStatus(message, type = 'info') {
    const statusContainer = document.getElementById('statusContainer');
    const statusDiv = document.createElement('div');
    statusDiv.className = `status-message ${type}`;

    const iconSvg = type === 'success'
        ? '<svg class="w-4 h-4 inline flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" style="color:#10B981"><path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z" clip-rule="evenodd"/></svg>'
        : type === 'error'
        ? '<svg class="w-4 h-4 inline flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" style="color:#EF4444"><path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd"/></svg>'
        : '<svg class="w-4 h-4 inline flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" style="color:#3B82F6"><path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm8.706-1.442c1.146-.573 2.437.463 2.126 1.706l-.709 2.836.042-.02a.75.75 0 01.67 1.34l-.04.022c-1.147.573-2.438-.463-2.127-1.706l.71-2.836-.042.02a.75.75 0 11-.671-1.34l.041-.022zM12 9a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd"/></svg>';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'status-close-btn';
    closeBtn.setAttribute('aria-label', 'Close notification');
    closeBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';

    const progressBar = document.createElement('div');
    progressBar.className = 'status-progress-bar';

    statusDiv.innerHTML = `${iconSvg} <span class="status-message-text">${message}</span>`;
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
        const isExpired = state.accountInfo.is_expired;

        const subDays = document.getElementById('subscriptionDays');
        const subBox = document.getElementById('subscriptionDaysBox');
        if (subDays) {
            if (isExpired) {
                subDays.textContent = '0d';
                subDays.style.color = '#EF4444';
            } else {
                subDays.textContent = `${Math.max(0, daysUntilExpiry)}d`;
                subDays.style.color = daysUntilExpiry <= RENEWAL_WARNING_DAYS ? '#fbbf24' : '#38bdf8';
            }
        }
        if (subBox) {
            if (isExpired) {
                subBox.title = 'Subscription expired. Renew now to regain access.';
            } else if (daysUntilExpiry <= RENEWAL_WARNING_DAYS) {
                subBox.title = `${daysUntilExpiry} days remaining. Click Renew to extend your subscription.`;
            } else {
                subBox.title = `${daysUntilExpiry} days remaining. You can renew when 90 days or fewer are left.`;
            }
        }

        const renewBtn = document.getElementById('renewBtn');
        if (renewBtn) {
            if (isExpired || daysUntilExpiry <= RENEWAL_WARNING_DAYS) {
                renewBtn.style.display = '';
            } else {
                renewBtn.style.display = 'none';
            }
        }
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

    // On mobile the sidebar (email list) and the reading pane stack
    // vertically; record the active view so CSS can show only the relevant
    // one (the inbox list for 'inbox', otherwise the reading pane).
    const mainApp = document.getElementById('mainApp');
    if (mainApp) mainApp.dataset.mview = viewName;
}

export function renderEmailList() {
    const emailList = document.getElementById('emailList');

    if (state.emails.length === 0) {
        renderEmptyInbox();
        refreshCheckboxControls();
        return;
    }

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
            dateDisplay = formatDateDMY(date).substring(0, 5); // DD/MM
        } else {
            dateDisplay = formatDateDMY(date);
        }

        const senderName = (email.from || email.sender || 'Unknown Sender').replace(/<.*?>/, '').trim() || 'Unknown Sender';
        const subject = email.subject || 'No Subject';
        const preview = (email.body_preview || email.preview || '').substring(0, 100);
        const isUnread = email.read === false;
        const isSelected = state.selectedEmailIds.has(email.id);

        return `
            <div class="flex items-start gap-3 p-4 border-b border-sky-900/40 hover:bg-sky-500/5 ${isUnread ? 'bg-sky-500/10 border-l-2 border-l-cyber-blue' : ''} cursor-pointer email-snippet" data-email-id="${email.id}">
                <input type="checkbox" class="email-checkbox mt-1 w-4 h-4 rounded border-sky-900/50 bg-slate-900 text-cyber-blue cursor-pointer" data-email-id="${email.id}" ${isSelected ? 'checked' : ''}>
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-start mb-1">
                        <span class="text-sm font-mono text-sky-400 truncate" style="font-family:'JetBrains Mono',monospace;">${escapeHtml(senderName)}</span>
                        <span class="text-[10px] text-slate-500 uppercase flex-shrink-0 ml-2">${dateDisplay}</span>
                    </div>
                    <h3 class="text-sm font-semibold text-white mb-1 truncate">${escapeHtml(subject)}</h3>
                    ${preview ? `<p class="text-xs text-slate-400 truncate">${escapeHtml(preview)}</p>` : ''}
                </div>
            </div>`;
    }).join('');

    emailList.innerHTML = emailRows + renderPaginationControls(totalPages);

    emailList.querySelectorAll('.email-snippet').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.matches('input[type="checkbox"]')) {
                openEmail(item.dataset.emailId);
            }
        });
    });

    bindCheckboxEvents();
    bindPaginationEvents();
}

function renderPaginationControls(totalPages) {
    if (totalPages <= 1) return '';

    let paginationHtml = `<div class="pagination-controls">`;
    paginationHtml += `<button class="pagination-btn" data-page="${state.currentPage - 1}" ${state.currentPage === 1 ? 'disabled' : ''}><svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg> Prev</button>`;
    paginationHtml += `<span class="pagination-info">Page ${state.currentPage} of ${totalPages}</span>`;
    paginationHtml += `<button class="pagination-btn" data-page="${state.currentPage + 1}" ${state.currentPage === totalPages ? 'disabled' : ''}>Next <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg></button>`;
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

let staticControlsBound = false;

function bindCheckboxEvents() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const emailCheckboxes = document.querySelectorAll('.email-checkbox');
    const deleteBtn = document.getElementById('deleteSelectedBtn');

    if (selectAllCheckbox && !staticControlsBound) {
        selectAllCheckbox.addEventListener('change', () => {
            const isChecked = selectAllCheckbox.checked;
            document.querySelectorAll('.email-checkbox').forEach(checkbox => {
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
        staticControlsBound = true;
    }

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

    updateSelectAllState();
    updateDeleteButtonState();

    function updateSelectAllState() {
        const checkedCount = document.querySelectorAll('.email-checkbox:checked').length;
        const totalCount = document.querySelectorAll('.email-checkbox').length;

        if (selectAllCheckbox) {
            selectAllCheckbox.checked = checkedCount === totalCount && totalCount > 0;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < totalCount;
        }
    }

    function updateDeleteButtonState() {
        const checkedCount = state.selectedEmailIds.size;
        if (deleteBtn) {
            deleteBtn.disabled = checkedCount === 0;
            deleteBtn.title = checkedCount > 0 ? `Delete ${checkedCount} selected` : 'Delete Selected';
        }
    }
}

function refreshCheckboxControls() {
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const deleteBtn = document.getElementById('deleteSelectedBtn');

    if (selectAllCheckbox) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    }
    if (deleteBtn) {
        deleteBtn.disabled = true;
        deleteBtn.title = 'Delete Selected';
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
        <div class="flex flex-col items-center justify-center py-20 px-6 text-center">
            <svg class="w-12 h-12 text-slate-700 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>
            <h3 class="text-base font-semibold text-slate-500 mt-2">No emails found</h3>
            <p class="text-sm text-slate-600 mt-2 max-w-xs leading-relaxed">Your inbox is empty or there was an issue loading your emails.<br>Try refreshing or check your connection.</p>
        </div>
    `;
}

export function updateInboxCount() {
    const count = state.emails.filter(email => email.read === false).length;
    document.getElementById('inboxCount').textContent = count;
}

/**
 * Render a toggle bar above the email body so the user can switch between
 * HTML, plain text and source views.  Styled to match the primary nav.
 *
 * @param {boolean} hasPlain - Whether the email has a text/plain body.
 * @param {boolean} hasHtml  - Whether the email has a text/html body.
 * @param {string}  activeFormat - Currently active format ('html', 'plain', or 'source').
 */
export function renderBodyFormatToggle(hasPlain, hasHtml, activeFormat) {
    const container = document.getElementById('bodyFormatToggle');
    if (!container) return;

    if (!hasHtml) {
        container.innerHTML = '';
        return;
    }

    // Ensure active format is valid for what's available
    if (!hasPlain && activeFormat === 'plain') {
        activeFormat = 'html';
    }

    const ACTIVE_CLASS = 'bg-sky-500/10 border border-sky-500/20 text-cyber-blue shadow-[0_0_15px_rgba(56,189,248,0.1)]';
    const INACTIVE_CLASS = 'hover:bg-sky-900/30 text-sky-200';

    const buttons = [
        {
            format: 'html',
            label: 'HTML',
            svg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
        },
    ];

    if (hasPlain) {
        buttons.push({
            format: 'plain',
            label: 'Text',
            svg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h12M4 14h14M4 18h8"/></svg>',
        });
    }

    buttons.push({
        format: 'source',
        label: 'Source',
        svg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    });

    const buttonsHtml = buttons
        .map(b => {
            const cls = activeFormat === b.format
                ? `${ACTIVE_CLASS} body-fmt-btn active`
                : `${INACTIVE_CLASS} body-fmt-btn`;
            return `<button class="flex items-center gap-2 px-4 py-1.5 rounded-md transition-all ${cls}" data-format="${b.format}">
                ${b.svg} <span class="text-sm font-medium">${b.label}</span>
            </button>`;
        })
        .join('');

    container.innerHTML = `<div class="flex items-center gap-1 bg-sky-950/20 p-1 rounded-lg border border-sky-900/40">${buttonsHtml}</div>`;

    container.querySelectorAll('.body-fmt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const format = btn.dataset.format;
            if (format === state.currentBodyFormat) return;

            state.currentBodyFormat = format;

            container.querySelectorAll('.body-fmt-btn').forEach(b => {
                b.className = `flex items-center gap-2 px-4 py-1.5 rounded-md transition-all ${INACTIVE_CLASS} body-fmt-btn`;
            });
            btn.className = `flex items-center gap-2 px-4 py-1.5 rounded-md transition-all ${ACTIVE_CLASS} body-fmt-btn`;

            renderEmailBodyContent(state.currentEmail, format);
        });
    });
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
        const sizeDisplay = attachment.size ? formatFileSize(attachment.size) : '';
        const fileIcon = getFileIcon(filename);
        const isText = attachment.encoding === 'text' || isTextFile(filename);

        return `
            <div class="attachment-detail" data-attachment-index="${index}">
                <div class="attachment-info">
                    <span class="material-symbols-outlined" style="font-size:16px;color:${fileIcon.color}">${fileIcon.icon}</span>
                    <span class="attachment-name">${escapeHtml(filename)}</span>
                    ${sizeDisplay ? `<span class="attachment-size">(${sizeDisplay})</span>` : ''}
                    <span class="attachment-type">${escapeHtml(attachment.content_type || '')}</span>
                </div>
                <div class="attachment-actions">
                    ${hasContent ? `
                        <button class="btn-small attachment-download-btn"><svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg> Download</button>
                        ${isText ? `<button class="btn-small attachment-preview-btn"><svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg> Preview</button>` : ''}
                    ` : '<span class="attachment-note">No content available</span>'}
                </div>
            </div>
        `;
    }).join('');

    attachmentsContainer.innerHTML = `
        <div class="attachments-section">
            <h4><svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg> Attachments (${attachments.length})</h4>
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
        if (attachment.encoding === 'base64') {
            // Binary attachment: decode base64 to bytes
            const binaryString = atob(attachment.content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            blob = new Blob([bytes], { type: attachment.content_type || 'application/octet-stream' });
        } else {
            // Text attachment: use content directly
            blob = new Blob([attachment.content], { type: attachment.content_type || 'text/plain' });
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

        // For text attachments, content is already plain text
        const textContent = attachment.encoding === 'base64'
            ? atob(attachment.content)
            : attachment.content;
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
                    <button class="btn-small preview-download-btn"><svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg> Download</button>
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

    // Clear attachment file input and list
    const attachmentInput = document.getElementById('attachmentInput');
    if (attachmentInput) attachmentInput.value = '';
    const attachmentList = document.getElementById('attachmentList');
    if (attachmentList) attachmentList.innerHTML = '';
}

/**
 * Show or hide the "Can't pay this invoice? Get a new one" actions based
 * on whether the backend can re-issue from a different provider (i.e. it
 * has several NWC providers configured). ``ids`` defaults to the inbox
 * send/renewal wrappers.
 */
export function applyReissueAvailability(available, ids = ['newSendInvoiceWrap', 'newRenewalInvoiceWrap']) {
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = available ? '' : 'none';
    });
}

export function updateHealthStatus(healthData) {
    const healthStatusValue = document.getElementById('healthStatusValue');
    const healthVersionValue = document.getElementById('healthVersionValue');
    const healthTimestampValue = document.getElementById('healthTimestampValue');

    if (healthData.success && healthData.data) {
        applyReissueAvailability(!!healthData.data.reissue_available);
        if (healthStatusValue) {
            healthStatusValue.textContent = healthData.data.status || 'OK';
            healthStatusValue.style.color = '#28a745';
        }
        if (healthVersionValue) healthVersionValue.textContent = healthData.data.version || 'Unknown';

        if (healthTimestampValue) {
            if (healthData.data.timestamp) {
                const timestamp = new Date(healthData.data.timestamp);
                healthTimestampValue.textContent = formatDateTime24(timestamp);
            } else {
                healthTimestampValue.textContent = formatDateTime24(new Date());
            }
        }
    } else {
        if (healthStatusValue) {
            healthStatusValue.textContent = 'Error';
            healthStatusValue.style.color = '#dc3545';
        }
        if (healthVersionValue) healthVersionValue.textContent = '-';
        if (healthTimestampValue) healthTimestampValue.textContent = formatDateTime24(new Date());

        if (healthData.error) {
            showStatus(`Health check failed: ${healthData.error}`, 'error');
        }
    }
}

export function updateHealthStatusLoading() {
    const healthDot = document.getElementById('healthDot');
    const healthStatus = document.getElementById('healthStatus');
    const healthStatusValue = document.getElementById('healthStatusValue');

    if (healthDot) healthDot.style.background = '#fbbf24';
    if (healthStatus) healthStatus.textContent = 'API Status: Checking...';
    if (healthStatusValue) {
        healthStatusValue.textContent = 'Checking...';
        healthStatusValue.style.color = '#ffc107';
    }
}

// Login page health status functions
export function updateLoginHealthStatus(healthData) {
    const loginHealthIcon = document.getElementById('loginHealthIcon');
    const loginHealthStatus = document.getElementById('loginHealthStatus');
    const loginHealthStatusValue = document.getElementById('loginHealthStatusValue');
    const loginHealthVersionValue = document.getElementById('loginHealthVersionValue');
    const loginHealthTimestampValue = document.getElementById('loginHealthTimestampValue');

    if (healthData.success && healthData.data) {
        if (loginHealthIcon) {
            loginHealthIcon.textContent = 'check_circle';
            loginHealthIcon.style.color = '#28a745';
        }
        if (loginHealthStatus) loginHealthStatus.textContent = 'API Status: Online';

        if (loginHealthStatusValue) {
            loginHealthStatusValue.textContent = healthData.data.status || 'OK';
            loginHealthStatusValue.style.color = '#28a745';
        }
        if (loginHealthVersionValue) loginHealthVersionValue.textContent = healthData.data.version || 'Unknown';

        if (loginHealthTimestampValue) {
            if (healthData.data.timestamp) {
                const timestamp = new Date(healthData.data.timestamp);
                loginHealthTimestampValue.textContent = formatDateTime24(timestamp);
            } else {
                loginHealthTimestampValue.textContent = formatDateTime24(new Date());
            }
        }
    } else {
        if (loginHealthIcon) {
            loginHealthIcon.textContent = 'error';
            loginHealthIcon.style.color = '#dc3545';
        }
        if (loginHealthStatus) loginHealthStatus.textContent = 'API Status: Error';

        if (loginHealthStatusValue) {
            loginHealthStatusValue.textContent = 'Error';
            loginHealthStatusValue.style.color = '#dc3545';
        }
        if (loginHealthVersionValue) loginHealthVersionValue.textContent = '-';
        if (loginHealthTimestampValue) loginHealthTimestampValue.textContent = formatDateTime24(new Date());
    }

    updateConnectButtonState(healthData.success);
}

export function updateLoginHealthStatusLoading() {
    const loginHealthIcon = document.getElementById('loginHealthIcon');
    const loginHealthStatus = document.getElementById('loginHealthStatus');
    const loginHealthStatusValue = document.getElementById('loginHealthStatusValue');

    if (loginHealthIcon) {
        loginHealthIcon.textContent = 'progress_activity';
        loginHealthIcon.style.color = '#ffc107';
    }
    if (loginHealthStatus) loginHealthStatus.textContent = 'API Status: Checking...';
    if (loginHealthStatusValue) {
        loginHealthStatusValue.textContent = 'Checking...';
        loginHealthStatusValue.style.color = '#ffc107';
    }

    updateConnectButtonState(false);
}

export function updateConnectButtonState(isHealthy) {
    const connectBtn = document.getElementById('connectBtn');

    if (!connectBtn) return;

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

    // Set loading state for QR code
    const qrContainer = document.querySelector('.qr-code-container');
    qrContainer.innerHTML = `
        <div class="qr-loader">
            <svg class="w-5 h-5 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
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

/**
 * Calculate QR code rendering options that scale with data length.
 *
 * QRious renders each QR module as floor(size / moduleCount) pixels.
 * When the data is long enough to push the QR version up (more modules),
 * the module pixel size can drop to 1px, causing the QR code to occupy
 * only a fraction of the canvas. To avoid this:
 *   - Use error correction level 'L' (LN invoices have their own checksums).
 *   - Scale the internal canvas size so each module is always >= 3px.
 *
 * The canvas is then scaled down visually via CSS max-width so the
 * displayed size stays consistent regardless of the internal resolution.
 */
function getQRCodeSize(dataLength) {
    // Approximate module count per side for alphanumeric data at level L.
    // QR versions jump at certain data lengths; this is a conservative
    // estimate that ensures enough canvas pixels.
    //   Version 10: 57 modules, ~174 alphanumeric chars
    //   Version 15: 77 modules, ~412 alphanumeric chars
    //   Version 20: 97 modules, ~666 alphanumeric chars
    //   Version 25: 117 modules, ~1000 alphanumeric chars
    //   Version 30: 137 modules, ~1370 alphanumeric chars
    //   Version 40: 177 modules, ~2520 alphanumeric chars
    // We want at least 3 pixels per module for crisp rendering.
    const minModulePixels = 3;
    let estimatedModules;
    if (dataLength < 200) {
        estimatedModules = 57;
    } else if (dataLength < 400) {
        estimatedModules = 77;
    } else if (dataLength < 700) {
        estimatedModules = 97;
    } else if (dataLength < 1100) {
        estimatedModules = 117;
    } else if (dataLength < 1500) {
        estimatedModules = 137;
    } else {
        estimatedModules = 177;
    }
    return Math.max(250, estimatedModules * minModulePixels);
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
        canvas.style.maxWidth = '200px';
        canvas.style.height = 'auto';
        qrContainer.appendChild(canvas);

        // Uppercase the invoice for QR encoding. BOLT11 invoices use bech32
        // which is case-insensitive, and uppercase enables QR alphanumeric
        // mode (~40% more compact than byte mode for lowercase).
        const qrValue = paymentRequest.toUpperCase();
        const size = getQRCodeSize(qrValue.length);
        new QRious({
            element: canvas,
            value: qrValue,
            size: size,
            level: 'L',
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
            <svg class="w-12 h-12 mx-auto mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v1m6 11h2m-6 0h-2m4-4v1m-4-3v1m4-3v2m-4-2v2m4-1h2m-10 4h2m-4-4h2m-4 4h2m-4-4h2m-4 4h2m-4-4h2m-4 4h2" /></svg>
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
            statusIcon.textContent = 'progress_activity';
            statusIcon.style.color = '#ffc107';
            statusIcon.style.animation = 'spin 1s linear infinite';
            statusText.textContent = message || 'Waiting for payment...';
            break;
        case 'success':
            statusContainer.classList.add('success');
            statusIcon.textContent = 'check_circle';
            statusIcon.style.color = '#28a745';
            statusIcon.style.animation = '';
            statusText.textContent = message || 'Payment confirmed!';
            break;
        case 'error':
            statusContainer.classList.add('error');
            statusIcon.textContent = 'error';
            statusIcon.style.color = '#dc3545';
            statusIcon.style.animation = '';
            statusText.textContent = message || 'Payment failed';
            break;
        default:
            statusIcon.textContent = 'progress_activity';
            statusIcon.style.color = '#ffc107';
            statusIcon.style.animation = 'spin 1s linear infinite';
            statusText.textContent = message || 'Checking payment status...';
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
                statusIcon.textContent = 'progress_activity';
                statusIcon.style.color = '#28a745';
                statusIcon.style.animation = 'spin 1s linear infinite';
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
        const date = formatDateDMY(new Date(send.created_at));
        let statusIcon = 'schedule';
        let statusClass = 'pending';

        if (send.delivery_status === 'sent') {
            statusIcon = 'check_circle';
            statusClass = 'success';
        } else if (send.delivery_status === 'failed') {
            statusIcon = 'error';
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
                        <span class="material-symbols-outlined" style="font-size:14px;">${statusIcon}</span>
                    </span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

export function renderSentEmails() {
    const container = document.getElementById('sentEmailsList');
    if (!container) return;

    if (!state.recentSends || state.recentSends.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="material-symbols-outlined" style="font-size:48px;color:#1e293b;">send</span>
                <h3>No sent emails</h3>
                <p>Emails you send will appear here.</p>
            </div>`;
        return;
    }

    const rows = state.recentSends.map(send => {
        const date = new Date(send.created_at);
        const isToday = date.toDateString() === new Date().toDateString();
        const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const dateDisplay = isToday
            ? `Today at ${timePart}`
            : `${formatDateDMY(date)} at ${timePart}`;
        const fullDate = formatDateTime24(date);

        return `
            <tr class="hover:bg-sky-900/10 transition-colors group">
                <td class="px-6 py-4 text-sm text-sky-100">${escapeHtml(send.recipient)}</td>
                <td class="px-6 py-4 text-sm text-white">${escapeHtml(send.subject)}</td>
                <td class="px-6 py-4">
                    <div class="text-sm text-sky-200">${dateDisplay}</div>
                    <div class="text-[10px] text-slate-400">${fullDate} GMT</div>
                </td>
            </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="border border-sky-900/30 rounded-lg bg-tech-black/40 overflow-hidden">
            <table class="w-full text-left border-collapse" style="font-family:'JetBrains Mono',monospace;">
                <thead class="bg-sky-950/30 border-b border-sky-900/30">
                    <tr class="text-sky-500 text-[11px] uppercase tracking-widest">
                        <th class="px-6 py-3 font-bold">Destination</th>
                        <th class="px-6 py-3 font-bold">Subject</th>
                        <th class="px-6 py-3 font-bold">Date</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-sky-900/20">${rows}</tbody>
            </table>
        </div>`;
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

// ---- Renewal UI Functions ----

export function showRenewalModal() {
    document.getElementById('renewalModal').classList.add('active');
}

export function hideRenewalModal() {
    document.getElementById('renewalModal').classList.remove('active');
    // Reset modal to options view for next time
    resetRenewalModal();
}

function resetRenewalModal() {
    const options = document.getElementById('renewalOptions');
    const paymentInfo = document.getElementById('renewalPaymentInfo');
    if (options) options.style.display = '';
    if (paymentInfo) paymentInfo.style.display = 'none';

    // Reset the year selector and price
    const yearSelect = document.getElementById('renewalYears');
    if (yearSelect) yearSelect.value = '1';
    updateRenewalPriceDisplay(1);

    // Reset payment status
    updateRenewalPaymentStatus('pending', 'Waiting for payment...');

    // Reset cancel button
    const cancelBtn = document.getElementById('cancelRenewalBtn');
    if (cancelBtn) {
        cancelBtn.innerHTML = '<svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg> Cancel';
        cancelBtn.className = 'btn-secondary';
    }

    // Reset copy button visibility
    const copyBtn = document.getElementById('copyRenewalInvoiceBtn');
    if (copyBtn) copyBtn.style.display = '';
}

export function updateRenewalPriceDisplay(years) {
    const priceValue = document.getElementById('renewalPriceValue');
    const disclaimer = document.getElementById('multiYearDisclaimer');

    if (priceValue) {
        const totalPrice = RENEWAL_PRICE_PER_YEAR * years;
        priceValue.textContent = `${totalPrice} sats`;
    }

    if (disclaimer) {
        if (years > 1) {
            disclaimer.classList.remove('hidden');
        } else {
            disclaimer.classList.add('hidden');
        }
    }
}

export function updateRenewalModal(invoiceData) {
    // Switch from options view to payment view
    const options = document.getElementById('renewalOptions');
    const paymentInfo = document.getElementById('renewalPaymentInfo');
    if (options) options.style.display = 'none';
    if (paymentInfo) paymentInfo.style.display = '';

    // Fill in payment details
    document.getElementById('renewalPeriodValue').textContent =
        `${invoiceData.years} Year${invoiceData.years > 1 ? 's' : ''}`;
    document.getElementById('renewalAmountValue').textContent =
        `${invoiceData.price_sats} sats`;
    document.getElementById('renewalPaymentHashValue').textContent =
        invoiceData.payment_hash;

    // Format new expiry date
    if (invoiceData.new_expires_at) {
        const expiryDate = new Date(invoiceData.new_expires_at);
        document.getElementById('renewalNewExpiry').textContent = formatDateDMY(expiryDate);
    }

    // Set loading state for QR code
    const qrContainer = document.getElementById('renewalQrContainer');
    qrContainer.innerHTML = `
        <div class="qr-loader">
            <svg class="w-5 h-5 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
            <p>Generating QR Code...</p>
        </div>
    `;

    // Generate QR code
    generateRenewalQRCode(invoiceData.payment_request);
}

async function generateRenewalQRCode(paymentRequest) {
    try {
        await waitForQRCodeLibrary();

        if (typeof QRious === 'undefined') {
            throw new Error('QRious library failed to load');
        }

        const qrContainer = document.getElementById('renewalQrContainer');
        qrContainer.innerHTML = '';

        const canvas = document.createElement('canvas');
        canvas.style.maxWidth = '200px';
        canvas.style.height = 'auto';
        qrContainer.appendChild(canvas);

        const qrValue = paymentRequest.toUpperCase();
        const size = getQRCodeSize(qrValue.length);
        new QRious({
            element: canvas,
            value: qrValue,
            size: size,
            level: 'L',
        });

    } catch (error) {
        showStatus('QR code library unavailable, showing text invoice', 'warning');
        const container = document.getElementById('renewalQrContainer');
        if (container) {
            container.innerHTML = `
                <div class="qr-fallback-box">
                    <svg class="w-12 h-12 mx-auto mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v1m6 11h2m-6 0h-2m4-4v1m-4-3v1m4-3v2m-4-2v2m4-1h2m-10 4h2m-4-4h2m-4 4h2m-4-4h2m-4 4h2m-4-4h2m-4 4h2" /></svg>
                    <p class="qr-fallback-title">QR Code Unavailable</p>
                    <p class="qr-fallback-desc">Please copy the invoice manually:</p>
                    <textarea readonly class="qr-fallback-textarea">${paymentRequest}</textarea>
                </div>
            `;
        }
    }
}

export function updateRenewalPaymentStatus(status, message) {
    const statusIcon = document.getElementById('renewalPaymentStatusIcon');
    const statusText = document.getElementById('renewalPaymentStatusText');

    if (!statusIcon || !statusText) return;

    statusText.textContent = message;

    switch (status) {
        case 'pending':
            statusIcon.textContent = 'progress_activity';
            statusIcon.style.color = '#ffc107';
            statusIcon.style.animation = 'spin 1s linear infinite';
            break;
        case 'success':
            statusIcon.textContent = 'check_circle';
            statusIcon.style.color = '#28a745';
            statusIcon.style.animation = '';
            break;
        case 'error':
            statusIcon.textContent = 'error';
            statusIcon.style.color = '#dc3545';
            statusIcon.style.animation = '';
            break;
        default:
            statusIcon.textContent = 'progress_activity';
            statusIcon.style.color = '#ffc107';
            statusIcon.style.animation = 'spin 1s linear infinite';
    }
}

export function showRenewalBanner(text) {
    const banner = document.getElementById('renewalBanner');
    const bannerText = document.getElementById('renewalBannerText');
    if (banner) {
        banner.style.display = '';
        if (bannerText && text) {
            bannerText.textContent = text;
        }
    }
}

export function hideRenewalBanner() {
    const banner = document.getElementById('renewalBanner');
    if (banner) banner.style.display = 'none';
}

/**
 * Block or unblock the inbox/compose UI for expired accounts.
 * When blocked, a full-screen overlay prevents interaction with the main app
 * content, forcing the user to renew.
 */
export function setExpiredOverlay(show) {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    if (show) {
        mainContent.classList.add('expired-blocked');
        const composeBtn = document.getElementById('composeBtn');
        if (composeBtn) composeBtn.disabled = true;
    } else {
        mainContent.classList.remove('expired-blocked');
        const composeBtn = document.getElementById('composeBtn');
        if (composeBtn) composeBtn.disabled = false;
    }
}
