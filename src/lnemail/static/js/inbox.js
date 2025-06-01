/**
* Inbox functionality for LNemail
*/
document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const authSection = document.getElementById('auth-section');
    const inboxSection = document.getElementById('inbox-section');
    const emailListContainer = document.getElementById('email-list-container');
    const emailContentSection = document.getElementById('email-content');
    const accessTokenInput = document.getElementById('access-token-input');
    const authBtn = document.getElementById('auth-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const refreshBtn = document.getElementById('refresh-btn');
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
    let autoRefreshInterval = null;
    let currentEmailAddress = '';
    let emailsData = []; // Store for sorting and filtering

    // Check for existing access token
    const storedToken = localStorage.getItem(STORAGE_KEYS.accessToken);
    if (storedToken) {
        accessTokenInput.value = storedToken;
        authenticateAndLoadInbox(storedToken);
    }

    // Event Listeners
    authBtn.addEventListener('click', handleAuthentication);
    logoutBtn.addEventListener('click', handleLogout);
    refreshBtn.addEventListener('click', fetchEmails);
    backToListBtn.addEventListener('click', showEmailList);

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
            const accountData = await apiRequest(`${API_BASE_URL}/account`);
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
            emailContentSection.classList.remove('hidden');
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
        emailListContainer.classList.remove('hidden');
        // Refresh emails to show updated read statuses
        fetchEmails();
    }

    function handleLogout() {
        localStorage.removeItem(STORAGE_KEYS.accessToken);
        localStorage.removeItem(STORAGE_KEYS.emailAddress);
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
        // Clean up any blob URLs
        document.querySelectorAll('.download-btn').forEach(btn => {
            if (btn.href && btn.href.startsWith('blob:')) {
                URL.revokeObjectURL(btn.href);
            }
        });
    });
});
