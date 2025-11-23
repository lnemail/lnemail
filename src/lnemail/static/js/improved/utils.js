export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function formatEmailBody(body) {
    // Basic formatting - convert line breaks to <br>
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
