export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format a Date as DD/MM/YYYY (e.g. 21/06/2026).
 */
export function formatDateDMY(date) {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
}

/**
 * Format a Date as DD/MM/YYYY HH:MM:SS (24h).
 */
export function formatDateTime24(date) {
    const datePart = formatDateDMY(date);
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${datePart} ${h}:${min}:${s}`;
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
        'pdf': { icon: 'picture_as_pdf', color: '#dc3545' },
        'doc': { icon: 'description', color: '#2b579a' },
        'docx': { icon: 'description', color: '#2b579a' },
        'xls': { icon: 'table_chart', color: '#107c41' },
        'xlsx': { icon: 'table_chart', color: '#107c41' },
        'ppt': { icon: 'slideshow', color: '#d24726' },
        'pptx': { icon: 'slideshow', color: '#d24726' },
        'txt': { icon: 'description', color: '#6c757d' },
        'asc': { icon: 'code', color: '#6c757d' },
        'sig': { icon: 'code', color: '#6c757d' },
        'gpg': { icon: 'code', color: '#6c757d' },
        'pgp': { icon: 'code', color: '#6c757d' },
        'csv': { icon: 'grid_on', color: '#28a745' },
        'json': { icon: 'code', color: '#6c757d' },
        'xml': { icon: 'code', color: '#6c757d' },
        'log': { icon: 'description', color: '#6c757d' },
        'jpg': { icon: 'image', color: '#28a745' },
        'jpeg': { icon: 'image', color: '#28a745' },
        'png': { icon: 'image', color: '#28a745' },
        'gif': { icon: 'image', color: '#28a745' },
        'zip': { icon: 'folder_zip', color: '#ffc107' },
        'rar': { icon: 'folder_zip', color: '#ffc107' },
        'mp3': { icon: 'audio_file', color: '#17a2b8' },
        'mp4': { icon: 'video_file', color: '#6f42c1' },
        'avi': { icon: 'video_file', color: '#6f42c1' }
    };

    return iconMap[extension] || { icon: 'insert_drive_file', color: '#6c757d' };
}

/**
 * Format a byte count into a human-readable string (e.g. "1.2 KB").
 *
 * @param {number} bytes - Size in bytes.
 * @returns {string} Formatted size string.
 */
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
    const value = bytes / Math.pow(k, i);
    return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

export function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).catch(() => {
            return copyFallback(text);
        });
    }
    return copyFallback(text);
}

function copyFallback(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    let success = false;
    try {
        success = document.execCommand('copy');
    } catch (e) {
        // execCommand may throw in some environments
    }
    document.body.removeChild(textArea);
    if (!success) {
        return Promise.reject(new Error('Copy command failed'));
    }
    return Promise.resolve();
}

/**
 * Show visual feedback on a copy button: swaps icon to checkmark temporarily
 * and shows a toast notification.
 */
export function showCopyFeedback(button) {
    if (!button) return;

    // Save original appearance
    const originalHTML = button.innerHTML;
    const wasDisabled = button.disabled;

    // Swap button icon to checkmark
    const iconEl = button.querySelector('svg, .material-symbols-outlined, img');
    if (iconEl) {
        const originalIconHTML = iconEl.outerHTML;
        const checkSvg = '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="#10B981" viewBox="0 0 24 24" style="display:inline;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>';
        iconEl.outerHTML = checkSvg;
        button.disabled = true;

        setTimeout(() => {
            const newIcon = button.querySelector('svg');
            if (newIcon) newIcon.outerHTML = originalIconHTML;
            button.disabled = wasDisabled;
        }, 2000);
    } else {
        // No icon found, replace whole content
        const checkSvg = '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="#10B981" viewBox="0 0 24 24" style="display:inline;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>';
        button.innerHTML = `${checkSvg} <span style="color:#10B981;font-size:12px;">Copied!</span>`;
        button.disabled = true;

        setTimeout(() => {
            button.innerHTML = originalHTML;
            button.disabled = wasDisabled;
        }, 2000);
    }

    // Show floating "Copied!" badge next to button
    const badge = document.createElement('span');
    badge.textContent = 'Copied!';
    badge.style.cssText = 'position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:#10B981;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap;z-index:9999;pointer-events:none;animation:fadeInDown 0.2s ease;';
    button.style.position = button.style.position || 'relative';
    button.appendChild(badge);

    setTimeout(() => {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
    }, 2000);
}
