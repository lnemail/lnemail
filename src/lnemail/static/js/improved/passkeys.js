import {
    beginPasskeyAuthentication,
    beginPasskeyRegistration,
    finishPasskeyAuthentication,
    finishPasskeyRegistration,
} from './api.js';

export function passkeysSupported() {
    return Boolean(
        window.isSecureContext &&
        window.PublicKeyCredential &&
        navigator.credentials &&
        typeof navigator.credentials.create === 'function' &&
        typeof navigator.credentials.get === 'function'
    );
}

function base64urlToBuffer(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bufferToBase64url(value) {
    const bytes = new Uint8Array(value);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function creationOptionsFromJSON(options) {
    return {
        ...options,
        challenge: base64urlToBuffer(options.challenge),
        user: { ...options.user, id: base64urlToBuffer(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map(credential => ({
            ...credential,
            id: base64urlToBuffer(credential.id),
        })),
    };
}

function requestOptionsFromJSON(options) {
    return {
        ...options,
        challenge: base64urlToBuffer(options.challenge),
        allowCredentials: (options.allowCredentials || []).map(credential => ({
            ...credential,
            id: base64urlToBuffer(credential.id),
        })),
    };
}

function credentialToJSON(credential) {
    const response = {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
    };
    if (credential.response.attestationObject) {
        response.attestationObject = bufferToBase64url(credential.response.attestationObject);
        if (credential.response.getTransports) {
            response.transports = credential.response.getTransports();
        }
    } else {
        response.authenticatorData = bufferToBase64url(credential.response.authenticatorData);
        response.signature = bufferToBase64url(credential.response.signature);
        response.userHandle = credential.response.userHandle
            ? bufferToBase64url(credential.response.userHandle)
            : null;
    }

    return {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response,
    };
}

export async function createPasskey(name = 'Passkey') {
    const ceremony = await beginPasskeyRegistration();
    const credential = await navigator.credentials.create({
        publicKey: creationOptionsFromJSON(ceremony.options),
    });
    if (!credential) throw new Error('Passkey creation was canceled');
    return await finishPasskeyRegistration(
        ceremony.ceremony_id,
        credentialToJSON(credential),
        name,
    );
}

export async function recoverTokenWithPasskey() {
    const ceremony = await beginPasskeyAuthentication();
    const credential = await navigator.credentials.get({
        publicKey: requestOptionsFromJSON(ceremony.options),
    });
    if (!credential) throw new Error('Passkey sign-in was canceled');
    return await finishPasskeyAuthentication(
        ceremony.ceremony_id,
        credentialToJSON(credential),
    );
}
