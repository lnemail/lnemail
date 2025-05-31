"""
Email service for managing and accessing email accounts.
Modified to handle file permission issues between root and worker processes.
This module provides methods for creating email accounts,
listing emails, and retrieving email content via IMAP.
Enhanced with reverse chronological sorting, read status tracking, and attachment support.
"""

import email as email_lib
import imaplib
import json
import os
import secrets
import time
import uuid
import stat
from datetime import datetime, timezone
from email.header import decode_header
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

        # Shared file system paths
        self.requests_dir = settings.MAIL_REQUESTS_DIR
        self.responses_dir = settings.MAIL_RESPONSES_DIR

        # Ensure directories exist
        os.makedirs(self.requests_dir, exist_ok=True)
        os.makedirs(self.responses_dir, exist_ok=True)

        logger.info("Email service initialized")

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
        # Create a unique request ID
        request_id = str(uuid.uuid4())

        # Prepare request data
        request_data = {
            "id": request_id,
            "action": action,
            "params": params,
            "timestamp": time.time(),
        }

        # Write request to file
        request_path = os.path.join(self.requests_dir, f"{request_id}.json")
        lock_path = f"{request_path}.lock"

        # Create lock file first with appropriate permissions
        with open(lock_path, "w") as f:
            pass  # Just create the file
        self._set_permissions(lock_path)

        # Now acquire the lock and write the request
        with FileLock(lock_path):
            with open(request_path, "w") as f:
                json.dump(request_data, f)
            # Set permissions on the request file
            self._set_permissions(request_path)

        # Wait for response (with timeout)
        response_path = os.path.join(self.responses_dir, f"{request_id}.json")
        response_lock_path = f"{response_path}.lock"

        max_wait_time: float = 30.0  # seconds
        wait_interval: float = 0.5  # seconds
        total_waited: float = 0.0  # seconds

        while total_waited < max_wait_time:
            if os.path.exists(response_path):
                try:
                    # Check if the lock file exists, create it if needed
                    if not os.path.exists(response_lock_path):
                        with open(response_lock_path, "w") as f:
                            pass
                        self._set_permissions(response_lock_path)

                    with FileLock(response_lock_path):
                        with open(response_path, "r") as f:
                            response_data = json.load(f)

                        # Clean up response file after reading
                        try:
                            os.remove(response_path)
                            if os.path.exists(response_lock_path):
                                os.remove(response_lock_path)
                        except Exception as cleanup_error:
                            logger.warning(
                                f"Error cleaning up response files: {cleanup_error}"
                            )

                    # Clean up request file
                    try:
                        if os.path.exists(request_path):
                            os.remove(request_path)
                        if os.path.exists(lock_path):
                            os.remove(lock_path)
                    except Exception as cleanup_error:
                        logger.warning(
                            f"Error cleaning up request files: {cleanup_error}"
                        )

                    return response_data.get("success", False), response_data.get(
                        "data", {}
                    )

                except (json.JSONDecodeError, FileNotFoundError) as e:
                    logger.error(f"Error reading response file: {str(e)}")
                    time.sleep(wait_interval)
                    total_waited += wait_interval
                    continue
                except PermissionError as e:
                    logger.error(f"Permission error with response file: {str(e)}")
                    # Try to fix the permissions
                    try:
                        self._set_permissions(response_path)
                        if os.path.exists(response_lock_path):
                            self._set_permissions(response_lock_path)
                    except Exception:
                        pass
                    time.sleep(wait_interval)
                    total_waited += wait_interval
                    continue

            time.sleep(wait_interval)
            total_waited += wait_interval

        # Timeout occurred
        logger.error(f"Timeout waiting for response to request {request_id}")

        # Clean up request file
        try:
            if os.path.exists(request_path):
                os.remove(request_path)
            if os.path.exists(lock_path):
                os.remove(lock_path)
        except Exception as cleanup_error:
            logger.warning(
                f"Error cleaning up request files after timeout: {cleanup_error}"
            )

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

    def _check_read_status(self, mail: imaplib.IMAP4, email_id: bytes) -> bool:
        """Check if email has been read by examining IMAP flags.

        Args:
            mail: IMAP connection
            email_id: Email ID to check

        Returns:
            True if email has been read, False otherwise
        """
        try:
            # Convert bytes to string for IMAP fetch
            email_id_str = email_id.decode("utf-8")
            status, data = mail.fetch(email_id_str, "(FLAGS)")
            if status == "OK" and data and data[0]:
                # Handle bytes response properly
                flags_data = data[0]
                if isinstance(flags_data, bytes):
                    flags_str = flags_data.decode("utf-8", errors="replace")
                else:
                    flags_str = str(flags_data)
                return "\\Seen" in flags_str
        except Exception as e:
            logger.error(f"Error checking read status for email {email_id!r}: {e}")
        return False

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

    def _extract_text_attachments(
        self, msg: email_lib.message.Message
    ) -> List[Dict[str, str]]:
        """Extract plain text attachments from email message.

        Args:
            msg: Email message object

        Returns:
            List of attachment dictionaries with filename and content
        """
        attachments = []

        for part in msg.walk():
            if part.get_content_disposition() == "attachment":
                filename = part.get_filename()
                if not filename:
                    continue

                # Decode filename if needed
                filename = self._decode_header_value(filename)

                # Only process text files and files without extension (common for GPG)
                is_text_file = (
                    filename.lower().endswith((".txt", ".asc", ".gpg", ".pgp"))
                    or "." not in filename
                    or part.get_content_type().startswith("text/")
                )

                if is_text_file:
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            # Handle payload type properly
                            if isinstance(payload, bytes):
                                # Try to decode as text
                                charset = part.get_content_charset() or "utf-8"
                                try:
                                    content = payload.decode(charset, errors="replace")
                                except (UnicodeDecodeError, LookupError):
                                    # Fallback to latin-1 which can decode any byte sequence
                                    content = payload.decode(
                                        "latin-1", errors="replace"
                                    )
                            else:
                                # Already a string or other type
                                content = str(payload)

                            attachments.append(
                                {
                                    "filename": filename,
                                    "content": content,
                                    "content_type": part.get_content_type(),
                                }
                            )
                    except Exception as e:
                        logger.error(f"Error extracting attachment {filename}: {e}")

        return attachments

    def list_emails(self, email_address: str, password: str) -> List[Dict[str, Any]]:
        """List emails for an account via IMAP with reverse chronological sorting.

        Args:
            email_address: Email address to access
            password: Password for the email account

        Returns:
            List of email metadata dictionaries sorted by date (newest first)
        """
        emails: List[Dict[str, Any]] = []

        try:
            # Connect to IMAP server
            mail = imaplib.IMAP4(self.imap_host, self.imap_port)
            mail.login(email_address, password)
            mail.select("INBOX")

            # Search for all emails
            status, data = mail.search(None, "ALL")
            if status != "OK":
                logger.error(f"Failed to search emails: {status}")
                mail.close()
                mail.logout()
                return emails

            email_ids = data[0].split()

            # Process each email
            for email_id in email_ids:
                try:
                    status, data = mail.fetch(email_id, "(RFC822)")
                    if status != "OK" or not data or not data[0]:
                        continue

                    # Safely access the raw email data
                    item = data[0]
                    if not isinstance(item, tuple) or len(item) < 2:
                        continue

                    raw_email = item[1]
                    msg = email_lib.message_from_bytes(raw_email)

                    # Extract and decode headers
                    subject = self._decode_header_value(msg["Subject"])
                    sender = self._decode_header_value(msg["From"])
                    date_str = msg["Date"]
                    parsed_date = self._parse_email_date(date_str)

                    # Check read status
                    is_read = self._check_read_status(mail, email_id)

                    emails.append(
                        {
                            "id": email_id.decode(),
                            "subject": subject,
                            "sender": sender,
                            "date": date_str,
                            "parsed_date": parsed_date.isoformat(),
                            "read": is_read,
                        }
                    )

                except Exception as e:
                    logger.error(f"Error processing email ID {email_id}: {str(e)}")
                    continue

            mail.close()
            mail.logout()

            # Sort emails by parsed date in reverse chronological order (newest first)
            emails.sort(key=lambda x: x["parsed_date"], reverse=True)

        except Exception as e:
            logger.error(f"Error listing emails for {email_address}: {str(e)}")

        return emails

    def get_email_content(
        self, email_address: str, password: str, email_id: str
    ) -> Dict[str, Any]:
        """Get content of specific email via IMAP with attachment support.

        Args:
            email_address: Email address to access
            password: Password for the email account
            email_id: ID of the email to retrieve

        Returns:
            Dictionary with email content, metadata, and attachments
        """
        try:
            # Connect to IMAP server
            mail = imaplib.IMAP4(self.imap_host, self.imap_port)
            mail.login(email_address, password)
            mail.select("INBOX")

            # Fetch the email
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

            # Extract and decode headers
            subject = self._decode_header_value(msg["Subject"])
            sender = self._decode_header_value(msg["From"])
            date = msg["Date"]

            # Extract body content
            content_type = "text/plain"
            body = ""

            if msg.is_multipart():
                for part in msg.walk():
                    part_content_type = part.get_content_type()
                    if part_content_type in {"text/plain", "text/html"}:
                        try:
                            payload = part.get_payload(decode=True)
                            if payload is None:
                                continue
                            payload_bytes = cast(bytes, payload)
                            charset = part.get_content_charset() or "utf-8"
                            body = payload_bytes.decode(charset, errors="replace")
                            content_type = part_content_type
                            break
                        except Exception as e:
                            logger.error(f"Error decoding email part: {str(e)}")
            else:
                try:
                    payload = msg.get_payload(decode=True)
                    if payload is not None:
                        payload_bytes = cast(bytes, payload)
                        charset = msg.get_content_charset() or "utf-8"
                        body = payload_bytes.decode(charset, errors="replace")
                        content_type = msg.get_content_type()
                except Exception as e:
                    logger.error(f"Error decoding email: {str(e)}")

            # Extract text attachments
            attachments = self._extract_text_attachments(msg)

            # Mark email as read
            self._mark_as_read(mail, email_id)

            mail.close()
            mail.logout()

            return {
                "id": email_id,
                "subject": subject,
                "sender": sender,
                "date": date,
                "body": body,
                "content_type": content_type,
                "attachments": attachments,
                "read": True,  # Set to True since we just marked it as read
            }

        except Exception as e:
            logger.error(f"Error getting email content: {str(e)}")
            return {}

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
