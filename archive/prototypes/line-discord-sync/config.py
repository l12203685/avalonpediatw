# -*- coding: utf-8 -*-
"""
Created on Sun Apr 13 20:37:53 2025

@author: user

NOTE (M0.1 consolidation): original file contained hardcoded LINE / Telegram /
Discord tokens. Tokens have been redacted here and must be supplied via .env
if this prototype is ever revived. See ENV_REDACTED placeholders below.
The exposed tokens have been rotated/revoked (or should be) at source.
"""

import os
from dotenv import load_dotenv
load_dotenv()

LINE_CHANNEL_SECRET = os.environ.get('LINE_CHANNEL_SECRET', 'ENV_REDACTED')
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', 'ENV_REDACTED')
LINE_GROUP_ID = os.environ.get('LINE_GROUP_ID', 'ENV_REDACTED')

TELEGRAM_TOKEN = os.environ.get('TELEGRAM_TOKEN', 'ENV_REDACTED')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', 'ENV_REDACTED')

DISCORD_TOKEN = os.environ.get('DISCORD_TOKEN', 'ENV_REDACTED')
DISCORD_CHANNEL_ID = int(os.environ.get('DISCORD_CHANNEL_ID', '0'))
DISCORD_WEBHOOK_URL = os.environ.get('DISCORD_WEBHOOK_URL', 'ENV_REDACTED')
