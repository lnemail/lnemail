/**
 * Common JavaScript functions for LNemail
 */

// API endpoints
const API_BASE_URL = '/api/v1';
const ENDPOINTS = {
  createEmail: `${API_BASE_URL}/email`,
  checkPayment: (hash) => `${API_BASE_URL}/payment/${hash}`,
  listEmails: `${API_BASE_URL}/emails`,
  getEmail: (id) => `${API_BASE_URL}/emails/${id}`
};

// Storage keys
const STORAGE_KEYS = {
  accessToken: 'lnemail_access_token',
  emailAddress: 'lnemail_email_address'
};

/**
 * Helper function to make API requests
 * @param {string} url - API endpoint
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} - JSON response
 */
async function apiRequest(url, options = {}) {
  try {
    // Get access token if stored
    const accessToken = localStorage.getItem(STORAGE_KEYS.accessToken);

    // Set default headers
    const headers = options.headers || {};
    headers['Content-Type'] = 'application/json';

    // Add authorization if token exists
    if (accessToken && !url.includes('/payment/')) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    // Make request
    const response = await fetch(url, {
      ...options,
      headers
    });

    // Parse JSON response
    const data = await response.json();

    // Handle error responses
    if (!response.ok) {
      throw new Error(data.detail || 'API request failed');
    }

    return data;
  } catch (error) {
    console.error('API request error:', error);
    throw error;
  }
}

/**
 * Format date string to more readable format
 * @param {string} dateString - ISO date string
 * @returns {string} - Formatted date
 */
function formatDate(dateString) {
  const date = new Date(dateString);

  // If invalid date, return original string
  if (isNaN(date.getTime())) return dateString;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // If today, show only time
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // If yesterday, show "Yesterday"
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Otherwise show date
  return date.toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - Success status
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Failed to copy text:', error);
    return false;
  }
}

/**
 * Show notification message
 * @param {string} message - Message to display
 * @param {string} type - Message type (success, error)
 */
function showNotification(message, type = 'success') {
  // Check if notification container exists
  let container = document.getElementById('notification-container');

  // Create container if it doesn't exist
  if (!container) {
    container = document.createElement('div');
    container.id = 'notification-container';
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '1000';
    document.body.appendChild(container);
  }

  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.style.backgroundColor = type === 'success' ? '#2ecc71' : '#e74c3c';
  notification.style.color = 'white';
  notification.style.padding = '12px 20px';
  notification.style.borderRadius = '6px';
  notification.style.marginTop = '10px';
  notification.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.1)';
  notification.style.transition = 'all 0.3s ease';
  notification.style.opacity = '0';
  notification.textContent = message;

  // Add to container
  container.appendChild(notification);

  // Trigger animation
  setTimeout(() => {
    notification.style.opacity = '1';
  }, 10);

  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      container.removeChild(notification);
    }, 300);
  }, 3000);
}

// Add event listeners to copy buttons
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.copy-btn').forEach(button => {
    button.addEventListener('click', async function() {
      const textElement = this.parentElement.querySelector('.copy-text');
      if (textElement) {
        const success = await copyToClipboard(textElement.textContent.trim());
        if (success) {
          showNotification('Copied to clipboard');
        }
      }
    });
  });
});

// Mobile menu toggle functionality
document.addEventListener('DOMContentLoaded', function() {
    // Find mobile toggle button if it exists
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
});
