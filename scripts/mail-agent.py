#!/usr/bin/env python3
"""
Mail agent script to process email account management requests.

This script monitors a shared directory for request files and executes
the appropriate mailserver commands to fulfill those requests.
"""

import json
import logging
import os
import subprocess
import sys
import time
import stat
from typing import Dict, Any
import inotify.adapters
from filelock import FileLock

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/var/log/mail-agent.log"),
    ],
)
logger = logging.getLogger("mail-agent")

# Configuration
REQUESTS_DIR = os.environ.get("MAIL_REQUESTS_DIR", "/shared/requests")
RESPONSES_DIR = os.environ.get("MAIL_RESPONSES_DIR", "/shared/responses")
# Worker UID and GID (uid 1000)
WORKER_UID = int(os.environ.get("WORKER_UID", 1000))
WORKER_GID = int(os.environ.get("WORKER_GID", 1000))


def set_permissions(file_path: str) -> None:
    """Set appropriate permissions for shared files.

    Args:
        file_path: Path to the file to set permissions on
    """
    try:
        # Make file readable and writable by both root and worker user
        os.chmod(
            file_path,
            stat.S_IRUSR
            | stat.S_IWUSR
            | stat.S_IRGRP
            | stat.S_IWGRP
            | stat.S_IROTH
            | stat.S_IWOTH,
        )
        # Change ownership to the worker user
        os.chown(file_path, WORKER_UID, WORKER_GID)
        logger.debug(f"Set permissions on {file_path}")
    except Exception as e:
        logger.error(f"Failed to set permissions on {file_path}: {e}")


def process_create_account(params: Dict[str, Any]) -> Dict[str, Any]:
    """Process a request to create an email account.

    Args:
        params: Dictionary containing email_address and password

    Returns:
        Dictionary with success status and any relevant data
    """
    email_address = params.get("email_address")
    password = params.get("password")

    if not email_address or not password:
        return {
            "success": False,
            "data": {"error": "Missing email_address or password parameter"},
        }

    try:
        # Execute the setup command within the current container
        cmd = [
            "setup",
            "email",
            "add",
            email_address,
            password,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, check=False)

        if result.returncode == 0:
            logger.info(f"Created email account: {email_address}")
            return {
                "success": True,
                "data": {"message": "Email account created successfully"},
            }
        else:
            logger.error(f"Failed to create email account: {result.stderr}")
            return {
                "success": False,
                "data": {"error": f"Command failed: {result.stderr}"},
            }

    except Exception as e:
        logger.error(f"Error creating email account: {str(e)}")
        return {"success": False, "data": {"error": str(e)}}


def process_delete_account(params: Dict[str, Any]) -> Dict[str, Any]:
    """Process a request to delete an email account.

    Args:
        params: Dictionary containing email_address

    Returns:
        Dictionary with success status and any relevant data
    """
    email_address = params.get("email_address")

    if not email_address:
        return {"success": False, "data": {"error": "Missing email_address parameter"}}

    try:
        # Execute the setup command within the current container
        cmd = [
            "setup",
            "email",
            "del",
            email_address,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, check=False)

        if result.returncode == 0:
            logger.info(f"Deleted email account: {email_address}")
            return {
                "success": True,
                "data": {"message": "Email account deleted successfully"},
            }
        else:
            logger.error(f"Failed to delete email account: {result.stderr}")
            return {
                "success": False,
                "data": {"error": f"Command failed: {result.stderr}"},
            }

    except Exception as e:
        logger.error(f"Error deleting email account: {str(e)}")
        return {"success": False, "data": {"error": str(e)}}


def process_request(request_path: str) -> None:
    """Process a request file.

    Args:
        request_path: Path to the request file
    """
    try:
        # Acquire a lock on the request file to prevent race conditions
        lock_path = f"{request_path}.lock"
        with FileLock(lock_path):
            # Read the request file
            with open(request_path, "r") as f:
                request = json.load(f)

        request_id = request.get("id")
        action = request.get("action")
        params = request.get("params", {})

        logger.info(f"Processing request {request_id}, action: {action}")

        # Process based on action
        if action == "create":
            response = process_create_account(params)
        elif action == "delete":
            response = process_delete_account(params)
        else:
            response = {
                "success": False,
                "data": {"error": f"Unknown action: {action}"},
            }

        # Write response
        response_path = os.path.join(RESPONSES_DIR, f"{request_id}.json")
        response_data = {
            "id": request_id,
            "success": response["success"],
            "data": response["data"],
            "timestamp": time.time(),
        }

        # Create and set permissions on response lock file first
        response_lock_path = f"{response_path}.lock"
        with open(response_lock_path, "w") as f:
            pass  # Just create the file

        # Set permissions on the lock file
        set_permissions(response_lock_path)

        # Now acquire the lock and write the response
        with FileLock(response_lock_path):
            with open(response_path, "w") as f:
                json.dump(response_data, f)

            # Set permissions on the response file
            set_permissions(response_path)

        logger.info(
            f"Processed request {request_id} with status: {response['success']}"
        )

    except Exception as e:
        logger.error(f"Error processing request {request_path}: {str(e)}")


def ensure_directory_permissions() -> None:
    """Ensure the shared directories have the correct permissions."""
    try:
        # Set permissions on the directories
        for directory in [REQUESTS_DIR, RESPONSES_DIR]:
            os.chmod(directory, stat.S_IRWXU | stat.S_IRWXG | stat.S_IRWXO)  # 0777
            logger.info(f"Set permissions on directory: {directory}")
    except Exception as e:
        logger.error(f"Failed to set directory permissions: {e}")


def main() -> None:
    """Main function that monitors the requests directory."""
    logger.info("Mail agent starting...")

    # Ensure directories exist
    os.makedirs(REQUESTS_DIR, exist_ok=True)
    os.makedirs(RESPONSES_DIR, exist_ok=True)

    # Set appropriate permissions on the shared directories
    ensure_directory_permissions()

    # Process any existing requests
    for filename in os.listdir(REQUESTS_DIR):
        if filename.endswith(".json"):
            request_path = os.path.join(REQUESTS_DIR, filename)
            process_request(request_path)

    # Setup inotify to watch for new request files
    i = inotify.adapters.Inotify()
    i.add_watch(REQUESTS_DIR)

    logger.info(f"Watching directory {REQUESTS_DIR} for new requests...")

    try:
        for event in i.event_gen(yield_nones=False):
            (_, type_names, path, filename) = event

            # We're only interested in new files
            if "IN_CLOSE_WRITE" in type_names and filename.endswith(".json"):
                request_path = os.path.join(path, filename)
                process_request(request_path)

    except KeyboardInterrupt:
        logger.info("Mail agent stopping...")
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
