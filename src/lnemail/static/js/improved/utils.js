export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Configure DOMPurify: force all links to open in new tab safely.
// This hook runs on every sanitize() call, rewriting anchor attributes.
if (typeof DOMPurify !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });
}

/**
 * Format email body for display. Plain text is escaped and line-broken.
 * HTML content is sanitized with DOMPurify to prevent XSS while preserving
 * safe structure (links, paragraphs, lists, basic formatting).
 *
 * @param {string} body - The raw email body text.
 * @param {string} contentType - MIME type: "text/plain" or "text/html".
 * @returns {string} Safe HTML string ready for innerHTML assignment.
 */
export function formatEmailBody(body, contentType) {
    if (contentType === 'text/html' && typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(body, {
            // Allow only safe structural and formatting tags
            ALLOWED_TAGS: [
                'a', 'b', 'i', 'u', 'em', 'strong', 'p', 'br', 'hr',
                'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'table', 'thead', 'tbody', 'tr', 'th', 'td',
                'div', 'span', 'img', 'sub', 'sup', 'dl', 'dt', 'dd',
            ],
            // Allow only safe attributes -- no event handlers, no JS URIs
            ALLOWED_ATTR: [
                'href', 'src', 'alt', 'title', 'width', 'height',
                'colspan', 'rowspan', 'style',
            ],
            // Only allow http(s) and mailto links -- block javascript: URIs
            ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
            // Force all links to open in new tab for safety
            ADD_ATTR: ['target'],
            // Remove any tags not in the allow list (don't just strip attributes)
            KEEP_CONTENT: true,
            // After sanitization, force target="_blank" and rel="noopener noreferrer"
            // on all anchor tags via a DOMPurify hook
            RETURN_DOM: false,
        });
    }
    // Plain text fallback: escape HTML entities and convert newlines
    return escapeHtml(body).replace(/\n/g, '<br>');
}

export function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

export function isTextFile(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    const textExtensions = ['txt', 'asc', 'sig', 'gpg', 'pgp', 'csv', 'json', 'xml', 'log'];
    return textExtensions.includes(extension);
}

export function isValidBase64(str) {
    if (!str || typeof str !== 'string') {
        return false;
    }

    const trimmedStr = str.trim();
    if (trimmedStr === '') {
        return false; // Empty string is not valid Base64
    }

    try {
        // The most reliable way to check for Base64 is to decode it.
        // We also re-encode (`btoa`) to ensure it's a canonical representation,
        // which handles some edge cases.
        return btoa(atob(trimmedStr)) === trimmedStr;
    } catch (err) {
        // If atob() throws an error, it's not valid Base64.
        return false;
    }
}

export function getFileIcon(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    const iconMap = {
        'pdf': { icon: 'fa-file-pdf', color: '#dc3545' },
        'doc': { icon: 'fa-file-word', color: '#2b579a' },
        'docx': { icon: 'fa-file-word', color: '#2b579a' },
        'xls': { icon: 'fa-file-excel', color: '#107c41' },
        'xlsx': { icon: 'fa-file-excel', color: '#107c41' },
        'ppt': { icon: 'fa-file-powerpoint', color: '#d24726' },
        'pptx': { icon: 'fa-file-powerpoint', color: '#d24726' },
        'txt': { icon: 'fa-file-alt', color: '#6c757d' },
        'asc': { icon: 'fa-file-code', color: '#6c757d' },
        'sig': { icon: 'fa-file-code', color: '#6c757d' },
        'gpg': { icon: 'fa-file-code', color: '#6c757d' },
        'pgp': { icon: 'fa-file-code', color: '#6c757d' },
        'csv': { icon: 'fa-file-csv', color: '#28a745' },
        'json': { icon: 'fa-file-code', color: '#6c757d' },
        'xml': { icon: 'fa-file-code', color: '#6c757d' },
        'log': { icon: 'fa-file-alt', color: '#6c757d' },
        'jpg': { icon: 'fa-file-image', color: '#28a745' },
        'jpeg': { icon: 'fa-file-image', color: '#28a745' },
        'png': { icon: 'fa-file-image', color: '#28a745' },
        'gif': { icon: 'fa-file-image', color: '#28a745' },
        'zip': { icon: 'fa-file-archive', color: '#ffc107' },
        'rar': { icon: 'fa-file-archive', color: '#ffc107' },
        'mp3': { icon: 'fa-file-audio', color: '#17a2b8' },
        'mp4': { icon: 'fa-file-video', color: '#6f42c1' },
        'avi': { icon: 'fa-file-video', color: '#6f42c1' }
    };

    return iconMap[extension] || { icon: 'fa-file', color: '#6c757d' };
}

export async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
    } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }
}
