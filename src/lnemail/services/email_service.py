"""Email service for managing and accessing email accounts.
This module provides methods for creating email accounts,
listing, sending, and retrieving email content via IMAP.
"""

import base64
import email as email_lib
import imaplib
import json
import os
import secrets
import smtplib
import ssl
import stat
import time
import uuid
from datetime import datetime, timezone
from email import encoders
from email.header import decode_header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Tuple, Optional, cast
from filelock import FileLock
from loguru import logger
from ..config import settings


class EmailService:
    """Service for managing email accounts and access."""

    def __init__(self) -> None:
        """Initialize the email service with configuration settings."""
        self.mail_data_path = settings.MAIL_DATA_PATH
        self.mail_domain = settings.MAIL_DOMAIN
        self.imap_host = settings.IMAP_HOST
        self.imap_port = settings.IMAP_PORT

        # SMTP settings
        self.smtp_host = settings.SMTP_HOST
        self.smtp_port = settings.SMTP_PORT
        self.smtp_use_tls = settings.SMTP_USE_TLS

        # Shared file system paths
        self.requests_dir = settings.MAIL_REQUESTS_DIR
        self.responses_dir = settings.MAIL_RESPONSES_DIR

        # Ensure directories exist
        os.makedirs(self.requests_dir, exist_ok=True)
        os.makedirs(self.responses_dir, exist_ok=True)

        logger.info("Email service initialized")

    def _create_imap_connection(self) -> imaplib.IMAP4:
        """Create and return a secure IMAP connection.

        Returns:
            Configured IMAP connection with TLS enabled

        Raises:
            Exception: If connection fails
        """
        try:
            mail: imaplib.IMAP4
            if self.imap_port == 993:
                # Use implicit TLS (SSL) connection
                context = ssl.create_default_context()
                # For development environments with self-signed certificates
                if settings.DEBUG:
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                mail = imaplib.IMAP4_SSL(
                    host=self.imap_host, port=self.imap_port, ssl_context=context
                )
                logger.debug(
                    f"Created SSL IMAP connection to {self.imap_host}:{self.imap_port}"
                )
            else:
                # Use explicit TLS (STARTTLS) connection
                mail = imaplib.IMAP4(host=self.imap_host, port=self.imap_port)
                # Create SSL context
                context = ssl.create_default_context()
                # For development environments with self-signed certificates
                if settings.DEBUG:
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                # Upgrade to TLS
                mail.starttls(ssl_context=context)
                logger.debug(
                    f"Created STARTTLS IMAP connection to {self.imap_host}:{self.imap_port}"
                )
            return mail
        except Exception as e:
            logger.error(f"Failed to create IMAP connection: {e}")
            raise

    def _create_smtp_connection(self) -> smtplib.SMTP:
        """Create and return a secure SMTP connection.

        Returns:
            Configured SMTP connection with TLS enabled

        Raises:
            Exception: If connection fails
        """
        try:
            # Create SMTP connection
            smtp = smtplib.SMTP(self.smtp_host, self.smtp_port)

            if self.smtp_use_tls:
                # Create SSL context
                context = ssl.create_default_context()
                # For development environments with self-signed certificates
                if settings.DEBUG:
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                # Upgrade to TLS
                smtp.starttls(context=context)
                logger.debug(
                    f"Created STARTTLS SMTP connection to {self.smtp_host}:{self.smtp_port}"
                )
            else:
                logger.debug(
                    f"Created plain SMTP connection to {self.smtp_host}:{self.smtp_port}"
                )

            return smtp
        except Exception as e:
            logger.error(f"Failed to create SMTP connection: {e}")
            raise

    def _set_permissions(self, file_path: str) -> None:
        """Set appropriate permissions for shared files.

        Args:
            file_path: Path to the file to set permissions on
        """
        try:
            # Make file readable and writable by everyone (world access)
            # This is a bit permissive but needed for cross-process communication
            os.chmod(
                file_path,
                stat.S_IRUSR
                | stat.S_IWUSR
                | stat.S_IRGRP
                | stat.S_IWGRP
                | stat.S_IROTH
                | stat.S_IWOTH,
            )
            logger.debug(f"Set permissions on {file_path}")
        except Exception as e:
            logger.error(f"Failed to set permissions on {file_path}: {e}")

    def _cleanup_files(self, *paths: str) -> None:
        """Best-effort removal of request/response/lock files."""
        for path in paths:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception as cleanup_error:
                logger.warning(f"Error cleaning up {path}: {cleanup_error}")

    def _write_request(self, request_path: str, request_data: Dict[str, Any]) -> str:
        """Write a request file under a lock; return the lock path."""
        lock_path = f"{request_path}.lock"
        with open(lock_path, "w"):
            pass  # Just create the lock file
        self._set_permissions(lock_path)
        with FileLock(lock_path):
            with open(request_path, "w") as f:
                json.dump(request_data, f)
            self._set_permissions(request_path)
        return lock_path

    def _try_read_response(
        self, response_path: str, response_lock_path: str
    ) -> Dict[str, Any]:
        """Read and remove a response file under a lock.

        Raises on a malformed/missing file; the caller treats that as a
        transient condition and keeps polling.
        """
        if not os.path.exists(response_lock_path):
            with open(response_lock_path, "w"):
                pass
            self._set_permissions(response_lock_path)
        with FileLock(response_lock_path):
            with open(response_path, "r") as f:
                response_data: Dict[str, Any] = json.load(f)
        self._cleanup_files(response_path, response_lock_path)
        return response_data

    def _send_request(
        self, action: str, params: Dict[str, Any]
    ) -> Tuple[bool, Dict[str, Any]]:
        """Send a request to the mail agent and wait for a response.

        Args:
            action: The action to perform (create, delete)
            params: Parameters for the action

        Returns:
            Tuple of (success, response_data)
        """
        request_id = str(uuid.uuid4())
        request_data = {
            "id": request_id,
            "action": action,
            "params": params,
            "timestamp": time.time(),
        }

        request_path = os.path.join(self.requests_dir, f"{request_id}.json")
        lock_path = self._write_request(request_path, request_data)

        response_path = os.path.join(self.responses_dir, f"{request_id}.json")
        response_lock_path = f"{response_path}.lock"

        max_wait_time: float = 30.0
        wait_interval: float = 0.5
        total_waited: float = 0.0

        while total_waited < max_wait_time:
            if os.path.exists(response_path):
                try:
                    response_data = self._try_read_response(
                        response_path, response_lock_path
                    )
                    self._cleanup_files(request_path, lock_path)
                    return (
                        response_data.get("success", False),
                        response_data.get("data", {}),
                    )
                except (json.JSONDecodeError, FileNotFoundError) as e:
                    logger.error(f"Error reading response file: {str(e)}")
                except PermissionError as e:
                    logger.error(f"Permission error with response file: {str(e)}")
                    try:
                        self._set_permissions(response_path)
                        if os.path.exists(response_lock_path):
                            self._set_permissions(response_lock_path)
                    except Exception:
                        pass

            time.sleep(wait_interval)
            total_waited += wait_interval

        logger.error(f"Timeout waiting for response to request {request_id}")
        self._cleanup_files(request_path, lock_path)
        return False, {"error": "Timeout waiting for response"}

    def create_account(self, email_address: str) -> Tuple[bool, str]:
        """Create a new email account via mail agent.

        Args:
            email_address: The email address to create

        Returns:
            Tuple containing success status and the generated password
        """
        try:
            # Generate a secure random password for the account
            password = secrets.token_urlsafe(16)

            # Send create account request
            success, response = self._send_request(
                "create", {"email_address": email_address, "password": password}
            )

            if success:
                logger.info(f"Created email account: {email_address}")
                return True, password
            else:
                error_msg = response.get("error", "Unknown error")
                logger.error(f"Failed to create email account: {error_msg}")
                return False, ""
        except Exception as e:
            logger.error(f"Error creating email account: {str(e)}")
            return False, ""

    @staticmethod
    def _attach_files(msg: MIMEMultipart, attachments: list[Dict[str, str]]) -> None:
        """Attach base64-encoded files to a MIME message."""
        for att in attachments:
            maintype, _, subtype = att["content_type"].partition("/")
            if not subtype:
                maintype = "application"
                subtype = "octet-stream"
            mime_part = MIMEBase(maintype, subtype)
            mime_part.set_payload(base64.b64decode(att["content"]))
            encoders.encode_base64(mime_part)
            mime_part.add_header(
                "Content-Disposition", "attachment", filename=att["filename"]
            )
            msg.attach(mime_part)

    def _build_outgoing_message(
        self,
        sender: str,
        recipient: str,
        subject: str,
        body: str,
        timestamp: datetime,
        in_reply_to: str | None,
        references: str | None,
        attachments: list[Dict[str, str]] | None,
    ) -> MIMEMultipart:
        """Assemble the outgoing MIME message (headers, body, attachments)."""
        msg = MIMEMultipart()
        msg["From"] = sender
        msg["To"] = recipient
        msg["Subject"] = subject
        msg["Date"] = timestamp.strftime("%a, %d %b %Y %H:%M:%S %z")
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
        if references:
            msg["References"] = references
        msg.attach(MIMEText(body, "plain"))
        if attachments:
            self._attach_files(msg, attachments)
        return msg

    def send_email_with_auth(
        self,
        sender: str,
        sender_password: str,
        recipient: str,
        subject: str,
        body: str,
        in_reply_to: str | None = None,
        references: str | None = None,
        attachments: list[Dict[str, str]] | None = None,
    ) -> Tuple[bool, str]:
        """Send an email via SMTP with authentication.

        Args:
            sender: The email address from which to send
            sender_password: The password for the sender's email account
            recipient: The email address to send to
            subject: The subject of the email
            body: The plain text body of the email
            in_reply_to: Message-ID of the email being replied to
            references: References header for email threading
            attachments: List of attachment dicts with keys: filename,
                content_type, content (base64-encoded string)

        Returns:
            Tuple containing success status and an optional error message or confirmation
        """
        try:
            utc_timestamp = datetime.now(timezone.utc)
            msg = self._build_outgoing_message(
                sender,
                recipient,
                subject,
                body,
                utc_timestamp,
                in_reply_to,
                references,
                attachments,
            )

            smtp = self._create_smtp_connection()
            try:
                smtp.login(sender, sender_password)
                smtp.send_message(msg)
                logger.info(
                    f"Successfully sent email from {sender} to {recipient} "
                    f"at {utc_timestamp.isoformat()}"
                )
                return True, f"Email sent successfully at {utc_timestamp.isoformat()}"
            finally:
                smtp.quit()

        except smtplib.SMTPAuthenticationError as e:
            error_msg = f"SMTP authentication failed for {sender}: {str(e)}"
            logger.error(error_msg)
            return False, error_msg
        except smtplib.SMTPRecipientsRefused as e:
            error_msg = f"Recipient {recipient} refused: {str(e)}"
            logger.error(error_msg)
            return False, error_msg
        except smtplib.SMTPSenderRefused as e:
            error_msg = f"Sender {sender} refused: {str(e)}"
            logger.error(error_msg)
            return False, error_msg
        except Exception as e:
            error_msg = f"Failed to send email: {str(e)}"
            logger.error(error_msg)
            return False, error_msg

    def _decode_header_value(self, header_value: Optional[str]) -> str:
        """Safely decode email header values.

        Args:
            header_value: Raw header value from email

        Returns:
            Decoded string value
        """
        if not header_value:
            return ""

        decoded_parts = decode_header(header_value)
        decoded_value = ""

        for part, encoding in decoded_parts:
            if isinstance(part, bytes):
                decoded_value += part.decode(encoding or "utf-8", errors="replace")
            else:
                decoded_value += str(part)

        return decoded_value

    def _safe_get_header(
        self, msg: email_lib.message.Message, header_name: str, default: str | None = ""
    ) -> str | None:
        """Safely extract email header with fallback to default value.

        Args:
            msg: Email message object
            header_name: Name of the header to extract
            default: Default value if header is missing or None

        Returns:
            Header value as string, or default if not found/None
        """
        try:
            header_value = msg.get(header_name)
            if header_value is None:
                return default
            return str(header_value)
        except Exception as e:
            logger.warning(f"Error extracting header '{header_name}': {e}")
            return default

    def _parse_email_date(self, date_str: Optional[str]) -> datetime:
        """Parse email date string to datetime object.

        Args:
            date_str: Raw date string from email header

        Returns:
            Parsed datetime object, defaults to epoch if parsing fails
        """
        if not date_str:
            return datetime.fromtimestamp(0, tz=timezone.utc)

        try:
            # Parse RFC 2822 date format
            parsed_date = parsedate_to_datetime(date_str)
            # Ensure timezone awareness
            if parsed_date.tzinfo is None:
                parsed_date = parsed_date.replace(tzinfo=timezone.utc)
            return parsed_date
        except (ValueError, TypeError) as e:
            logger.warning(f"Failed to parse date '{date_str}': {e}")
            return datetime.fromtimestamp(0, tz=timezone.utc)

    def _get_email_flags(self, mail: imaplib.IMAP4, email_id: str) -> List[str]:
        """Get IMAP flags for an email without modifying them.

        Args:
            mail: IMAP connection
            email_id: Email ID to check

        Returns:
            List of flags for the email
        """
        try:
            status, data = mail.fetch(email_id, "(FLAGS)")
            if status == "OK" and data and data[0]:
                # Handle bytes response properly
                flags_data = data[0]
                if isinstance(flags_data, bytes):
                    flags_str = flags_data.decode("utf-8", errors="replace")
                else:
                    flags_str = str(flags_data)

                # Extract flags from the response
                # Response format: b'1 (FLAGS (\\Seen \\Recent))'
                start = flags_str.find("(FLAGS (")
                if start != -1:
                    start += 8  # Length of "(FLAGS ("
                    end = flags_str.find("))", start)
                    if end != -1:
                        flags_part = flags_str[start:end]
                        return [
                            flag.strip() for flag in flags_part.split() if flag.strip()
                        ]
        except Exception as e:
            logger.error(f"Error getting flags for email {email_id}: {e}")
        return []

    def _check_read_status(self, mail: imaplib.IMAP4, email_id: str) -> bool:
        """Check if email has been read by examining IMAP flags.

        Args:
            mail: IMAP connection
            email_id: Email ID to check

        Returns:
            True if email has been read, False otherwise
        """
        flags = self._get_email_flags(mail, email_id)
        return "\\Seen" in flags

    def _mark_as_read(self, mail: imaplib.IMAP4, email_id: str) -> bool:
        """Mark email as read by setting IMAP \\Seen flag.

        Args:
            mail: IMAP connection
            email_id: Email ID to mark as read

        Returns:
            True if successful, False otherwise
        """
        try:
            status, _ = mail.store(email_id, "+FLAGS", "\\Seen")
            return status == "OK"
        except Exception as e:
            logger.error(f"Error marking email {email_id} as read: {e}")
            return False

    def _mark_as_unread(self, mail: imaplib.IMAP4, email_id: str) -> bool:
        """Mark email as unread by removing IMAP \\Seen flag.

        Args:
            mail: IMAP connection
            email_id: Email ID to mark as unread

        Returns:
            True if successful, False otherwise
        """
        try:
            status, _ = mail.store(email_id, "-FLAGS", "\\Seen")
            return status == "OK"
        except Exception as e:
            logger.error(f"Error marking email {email_id} as unread: {e}")
            return False

    @staticmethod
    def _is_attachment_part(part: email_lib.message.Message) -> bool:
        """Return True if a MIME part is an attachment (not a body part)."""
        disposition = part.get_content_disposition()
        if disposition not in ("attachment", "inline"):
            return False
        # Inline text parts are the email body itself, not attachments.
        if disposition == "inline" and part.get_content_type() in (
            "text/plain",
            "text/html",
        ):
            return False
        return True

    def _build_attachment(
        self, part: email_lib.message.Message
    ) -> Optional[Dict[str, Any]]:
        """Build a single attachment dict from a MIME part, or None to skip."""
        filename = part.get_filename()
        if not filename:
            ext = part.get_content_type().split("/")[-1]
            filename = f"attachment.{ext}"
        filename = self._decode_header_value(filename)
        content_type = part.get_content_type()

        payload = part.get_payload(decode=True)
        if payload is None:
            return None
        raw_bytes = cast(bytes, payload)

        is_text = content_type.startswith("text/") or filename.lower().endswith(
            (".txt", ".asc", ".gpg", ".pgp", ".csv", ".json", ".xml", ".log")
        )
        if is_text:
            charset = part.get_content_charset() or "utf-8"
            try:
                content = raw_bytes.decode(charset, errors="replace")
            except (UnicodeDecodeError, LookupError):
                content = raw_bytes.decode("latin-1", errors="replace")
            encoding = "text"
        else:
            content = base64.b64encode(raw_bytes).decode("ascii")
            encoding = "base64"

        return {
            "filename": filename,
            "content_type": content_type,
            "size": len(raw_bytes),
            "content": content,
            "encoding": encoding,
        }

    def _extract_attachments(
        self, msg: email_lib.message.Message
    ) -> List[Dict[str, Any]]:
        """Extract all attachments from email message.

        Extracts both text and binary attachments. Binary content is
        base64-encoded so it can be serialised in JSON responses.

        Args:
            msg: Email message object

        Returns:
            List of attachment dicts with keys: filename, content_type,
            size, content (base64-encoded bytes or plain text for text files),
            encoding ("base64" or "text").
        """
        attachments: List[Dict[str, Any]] = []

        for part in msg.walk():
            if not self._is_attachment_part(part):
                continue
            try:
                attachment = self._build_attachment(part)
                if attachment is not None:
                    attachments.append(attachment)
            except Exception as e:
                logger.error(f"Error extracting attachment: {e}")

        return attachments

    def _fetch_email_summary(
        self, mail: imaplib.IMAP4, email_id: bytes
    ) -> Optional[Dict[str, Any]]:
        """Fetch one email's header-only summary, or None if unavailable.

        Uses a header-only fetch so the message's read status is preserved.
        """
        email_id_str = email_id.decode("utf-8")
        is_read = self._check_read_status(mail, email_id_str)

        status, data = mail.fetch(email_id_str, "(RFC822.HEADER)")
        if status != "OK" or not data or not data[0]:
            return None
        item = data[0]
        if not isinstance(item, tuple) or len(item) < 2:
            return None

        msg = email_lib.message_from_bytes(item[1])
        subject = self._decode_header_value(
            self._safe_get_header(msg, "Subject", "(No Subject)")
        )
        sender = self._decode_header_value(
            self._safe_get_header(msg, "From", "(Unknown Sender)")
        )
        date_str = (
            self._safe_get_header(msg, "Date", "") or "Thu, 01 Jan 1970 00:00:00 +0000"
        )
        parsed_date = self._parse_email_date(date_str)
        return {
            "id": email_id_str,
            "subject": subject,
            "sender": sender,
            "date": date_str,
            "parsed_date": parsed_date.isoformat(),
            "read": is_read,
        }

    def list_emails(self, email_address: str, password: str) -> List[Dict[str, Any]]:
        """List emails for an account via IMAP with reverse chronological sorting.

        This method preserves the original read status of emails by only fetching
        headers and flags, not the full message content.

        Args:
            email_address: Email address to access
            password: Password for the email account

        Returns:
            List of email metadata dictionaries sorted by date (newest first)
        """
        emails: List[Dict[str, Any]] = []

        try:
            mail = self._create_imap_connection()
            mail.login(email_address, password)
            mail.select("INBOX")

            status, data = mail.search(None, "ALL")
            if status != "OK":
                logger.error(f"Failed to search emails: {status}")
                mail.close()
                mail.logout()
                return emails

            for email_id in data[0].split():
                try:
                    summary = self._fetch_email_summary(mail, email_id)
                    if summary is not None:
                        emails.append(summary)
                except Exception as e:
                    logger.error(f"Error processing email ID {email_id}: {str(e)}")

            mail.close()
            mail.logout()

            # Sort by parsed date, newest first.
            emails.sort(key=lambda x: x["parsed_date"], reverse=True)

        except Exception as e:
            logger.error(f"Error listing emails for {email_address}: {str(e)}")

        return emails

    @staticmethod
    def _decode_text_part(part: email_lib.message.Message) -> str | None:
        """Decode a text/* MIME part to a string, or None if undecodable."""
        try:
            payload = part.get_payload(decode=True)
            if payload is None:
                return None
            payload_bytes = cast(bytes, payload)
            charset = part.get_content_charset() or "utf-8"
            return payload_bytes.decode(charset, errors="replace")
        except Exception as e:
            logger.error(f"Error decoding email part: {str(e)}")
            return None

    @staticmethod
    def _is_body_part(part: email_lib.message.Message) -> bool:
        """Return True if a multipart member is a body part (not an attachment).

        Inline text/plain and text/html parts count as body; everything
        marked as an attachment (or inline non-text) is skipped.
        """
        disposition = part.get_content_disposition()
        if disposition in ("attachment", "inline"):
            return disposition == "inline" and part.get_content_type() in (
                "text/plain",
                "text/html",
            )
        return True

    @classmethod
    def _extract_multipart_body(cls, msg: email_lib.message.Message) -> tuple[str, str]:
        """Walk a multipart message and return ``(body_plain, body_html)``."""
        bodies: dict[str, str] = {}
        for part in msg.walk():
            if not cls._is_body_part(part):
                continue
            content_type = part.get_content_type()
            if content_type in bodies or content_type not in (
                "text/plain",
                "text/html",
            ):
                continue
            decoded = cls._decode_text_part(part)
            if decoded is not None:
                bodies[content_type] = decoded
            if "text/plain" in bodies and "text/html" in bodies:
                break
        return bodies.get("text/plain", ""), bodies.get("text/html", "")

    @classmethod
    def _extract_body_parts(cls, msg: email_lib.message.Message) -> tuple[str, str]:
        """Extract ``(body_plain, body_html)`` from a parsed email message."""
        if msg.is_multipart():
            return cls._extract_multipart_body(msg)

        decoded = cls._decode_text_part(msg)
        if decoded is None:
            return "", ""
        if msg.get_content_type() == "text/html":
            return "", decoded
        return decoded, ""

    def _finalize_read_status(
        self,
        mail: imaplib.IMAP4,
        email_id: str,
        mark_as_read: bool,
        initial_read_status: bool,
    ) -> bool:
        """Apply and return the email's read status after an RFC822 fetch.

        The fetch itself marks the message read, so we only need to act
        when the caller wants to preserve a previously-unread message.
        """
        if not mark_as_read and not initial_read_status:
            if self._mark_as_unread(mail, email_id):
                logger.debug(f"Restored unread status for email {email_id}")
                return False
            logger.warning(f"Failed to restore unread status for email {email_id}")
            return True
        if mark_as_read and not initial_read_status:
            self._mark_as_read(mail, email_id)
        return True

    def get_email_content(
        self,
        email_address: str,
        password: str,
        email_id: str,
        mark_as_read: bool = True,
    ) -> Dict[str, Any]:
        """Get content of specific email via IMAP with attachment support.

        Args:
            email_address: Email address to access
            password: Password for the email account
            email_id: ID of the email to retrieve
            mark_as_read: Whether to mark the email as read after fetching

        Returns:
            Dictionary with email content, metadata, and attachments
        """
        try:
            # Connect to IMAP server with TLS
            mail = self._create_imap_connection()
            mail.login(email_address, password)
            mail.select("INBOX")

            # Check initial read status
            initial_read_status = self._check_read_status(mail, email_id)

            # Fetch the email - this will mark it as read due to RFC822 fetch
            status, data = mail.fetch(email_id, "(RFC822)")
            if status != "OK" or not data or not data[0]:
                logger.error(f"Failed to fetch email {email_id}: {status}")
                mail.close()
                mail.logout()
                return {}

            # Safely access the raw email data
            item = data[0]
            if not isinstance(item, tuple) or len(item) < 2:
                mail.close()
                mail.logout()
                return {}

            raw_email = item[1]
            msg = email_lib.message_from_bytes(raw_email)

            # Extract and decode headers with safe fallbacks
            subject = self._decode_header_value(
                self._safe_get_header(msg, "Subject", "(No Subject)")
            )
            sender = self._decode_header_value(
                self._safe_get_header(msg, "From", "(Unknown Sender)")
            )
            date = self._safe_get_header(msg, "Date", "Thu, 01 Jan 1970 00:00:00 +0000")
            message_id = self._safe_get_header(msg, "Message-ID", None)
            references = self._safe_get_header(msg, "References", None)

            # Extract body content - capture both plain and HTML versions
            # so the frontend can offer a toggle between formats.
            body_plain, body_html = self._extract_body_parts(msg)

            # Determine the primary body and content_type for backward compat
            if body_html:
                body = body_html
                content_type = "text/html"
            else:
                body = body_plain
                content_type = "text/plain"

            # Extract all attachments (text + binary)
            attachments = self._extract_attachments(msg)

            # Handle read status based on parameters and initial state
            final_read_status = self._finalize_read_status(
                mail, email_id, mark_as_read, initial_read_status
            )

            mail.close()
            mail.logout()

            return {
                "id": email_id,
                "subject": subject,
                "sender": sender,
                "date": date,
                "body": body,
                "body_plain": body_plain or None,
                "body_html": body_html or None,
                "content_type": content_type,
                "attachments": attachments,
                "read": final_read_status,
                "message_id": message_id,
                "references": references,
            }

        except Exception as e:
            logger.error(f"Error getting email content: {str(e)}")
            return {}

    def mark_email_read_status(
        self, email_address: str, password: str, email_id: str, read: bool
    ) -> bool:
        """Mark an email's read status.

        Args:
            email_address: Email address to access
            password: Password for the email account
            email_id: ID of the email to modify
            read: Whether to mark as read (True) or unread (False)

        Returns:
            True if successful, False otherwise
        """
        try:
            # Connect to IMAP server with TLS
            mail = self._create_imap_connection()
            mail.login(email_address, password)
            mail.select("INBOX")

            # Mark read or unread based on parameter
            if read:
                success = self._mark_as_read(mail, email_id)
                action = "read"
            else:
                success = self._mark_as_unread(mail, email_id)
                action = "unread"

            mail.close()
            mail.logout()

            if success:
                logger.info(f"Marked email {email_id} as {action}")
            else:
                logger.error(f"Failed to mark email {email_id} as {action}")

            return success

        except Exception as e:
            logger.error(
                f"Error marking email {email_id} as {'read' if read else 'unread'}: {str(e)}"
            )
            return False

    def delete_email(self, email_address: str, password: str, email_id: str) -> bool:
        """Delete a specific email via IMAP.

        Args:
            email_address: Email address to access
            password: Password for the email account
            email_id: ID of the email to delete

        Returns:
            True if successful, False otherwise
        """
        try:
            # Connect to IMAP server with TLS
            mail = self._create_imap_connection()
            mail.login(email_address, password)
            mail.select("INBOX")

            # Mark email for deletion
            status, _ = mail.store(email_id, "+FLAGS", "\\Deleted")
            if status != "OK":
                logger.error(f"Failed to mark email {email_id} for deletion")
                mail.close()
                mail.logout()
                return False

            # Expunge to permanently delete
            mail.expunge()

            mail.close()
            mail.logout()

            logger.info(f"Successfully deleted email {email_id}")
            return True

        except Exception as e:
            logger.error(f"Error deleting email {email_id}: {str(e)}")
            return False

    def delete_emails_bulk(
        self, email_address: str, password: str, email_ids: List[str]
    ) -> Tuple[bool, List[str]]:
        """Delete multiple emails via IMAP.

        Args:
            email_address: Email address to access
            password: Password for the email account
            email_ids: List of email IDs to delete

        Returns:
            Tuple of (success, list of failed email IDs)
        """
        failed_ids: list[str] = []

        if not email_ids:
            return True, failed_ids

        try:
            # Connect to IMAP server with TLS
            mail = self._create_imap_connection()
            mail.login(email_address, password)
            mail.select("INBOX")

            # Mark all emails for deletion
            for email_id in email_ids:
                try:
                    status, _ = mail.store(email_id, "+FLAGS", "\\Deleted")
                    if status != "OK":
                        logger.error(f"Failed to mark email {email_id} for deletion")
                        failed_ids.append(email_id)
                except Exception as e:
                    logger.error(
                        f"Error marking email {email_id} for deletion: {str(e)}"
                    )
                    failed_ids.append(email_id)

            # Expunge to permanently delete all marked emails
            mail.expunge()

            mail.close()
            mail.logout()

            successful_count = len(email_ids) - len(failed_ids)
            logger.info(
                f"Successfully deleted {successful_count} out of {len(email_ids)} emails"
            )
            return len(failed_ids) == 0, failed_ids

        except Exception as e:
            logger.error(f"Error during bulk email deletion: {str(e)}")
            return False, email_ids

    def delete_account(self, email_address: str) -> bool:
        """Delete an email account from the mail server.

        Args:
            email_address: The email address to delete

        Returns:
            True if successful, False otherwise
        """
        try:
            # Send delete account request
            success, response = self._send_request(
                "delete", {"email_address": email_address}
            )

            if success:
                logger.info(f"Deleted email account: {email_address}")
                return True
            else:
                error_msg = response.get("error", "Unknown error")
                logger.error(f"Failed to delete email account: {error_msg}")
                return False
        except Exception as e:
            logger.error(f"Error deleting email account: {str(e)}")
            return False
