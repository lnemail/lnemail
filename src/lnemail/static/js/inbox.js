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
    let autoRefreshInterval = null;
    let currentEmailAddress = '';

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

    // Add a logout button to auth section as well
    function addResetButton() {
        // Check if button already exists
        if (document.getElementById('reset-auth-btn')) {
            return;
        }

        // Create a container for the logout button
        const resetContainer = document.createElement('div');
        resetContainer.className = 'form-group reset-container';
        resetContainer.style.marginTop = '20px';
        resetContainer.style.textAlign = 'center';

        // Create the button
        const resetBtn = document.createElement('button');
        resetBtn.id = 'reset-auth-btn';
        resetBtn.className = 'btn secondary';
        resetBtn.textContent = 'Cancel and Start Over';
        resetBtn.addEventListener('click', handleLogout);

        // Add to container
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
            // Get account details
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

    async function fetchEmails() {
        showLoadingState();
        try {
            const response = await apiRequest(ENDPOINTS.listEmails);
            // Check if the response contains the emails array
            const emails = Array.isArray(response) ? response : (response.emails || []);
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
            const emailElement = document.createElement('div');
            emailElement.className = 'email-list-item';
            emailElement.innerHTML = `
                <div class="email-col from">${email.sender || email.from}</div>
                <div class="email-col subject">${email.subject}</div>
                <div class="email-col date">${formatDate(email.date)}</div>
            `;
            emailElement.addEventListener('click', () => showEmailContent(email.id));
            emailList.appendChild(emailElement);
        });
        loadingDiv.classList.add('hidden');
        noEmailsDiv.classList.add('hidden');
    }

    async function showEmailContent(emailId) {
        showLoadingState();
        try {
            const email = await apiRequest(ENDPOINTS.getEmail(emailId));
            populateEmailContent(email);

            emailListContainer.classList.add('hidden');
            emailContentSection.classList.remove('hidden');
        } catch (error) {
            showNotification('Failed to load email', 'error');
        }
    }

    function populateEmailContent(email) {
        document.getElementById('email-subject').textContent = email.subject;
        document.getElementById('email-from').textContent = email.sender || email.from;
        document.getElementById('email-to').textContent = currentEmailAddress || email.to;
        document.getElementById('email-date').textContent = formatDate(email.date);
        document.getElementById('email-text').textContent = email.body || email.text_body;
        // Only try to use HTML body if it exists
        const htmlBody = email.html_body || '';
        const htmlContent = document.getElementById('email-html');
        htmlContent.innerHTML = htmlBody;
        htmlContent.classList.toggle('hidden', !htmlBody);
    }

    function showEmailList() {
        emailContentSection.classList.add('hidden');
        emailListContainer.classList.remove('hidden');
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
        emailList.innerHTML = '';
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

    // Add reset button to auth section
    addResetButton();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    });
});
