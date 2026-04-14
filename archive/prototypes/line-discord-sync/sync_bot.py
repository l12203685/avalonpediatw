from flask import Flask, request
from linebot.v3.webhook import WebhookHandler
from linebot.v3.webhooks import MessageEvent
from linebot.v3.webhooks.models import TextMessageContent
from linebot.v3.messaging import MessagingApi, Configuration, ApiClient
from linebot import LineBotApi
from linebot.models import TextSendMessage
from linebot.v3.messaging.models import TextMessage, PushMessageRequest
from telegram import Bot, Update
from telegram.ext import Updater, MessageHandler, Filters, CallbackContext
import discord
import threading
import asyncio
import config
import utilities as utils

app = Flask(__name__)

configuration = Configuration(access_token=config.LINE_CHANNEL_ACCESS_TOKEN)
line_bot_api = MessagingApi(ApiClient(configuration))
line_bot_api_old = LineBotApi(config.LINE_CHANNEL_ACCESS_TOKEN)
group_id = config.LINE_GROUP_ID
handler = WebhookHandler(config.LINE_CHANNEL_SECRET)
telegram_bot = Bot(token=config.TELEGRAM_TOKEN)
discord_client = discord.Client(intents=discord.Intents.all())
loop = asyncio.get_event_loop()


@app.route("/callback", methods=['POST'])
def callback():
    signature = request.headers['x-line-signature']
    body = request.get_data(as_text=True)
    handler.handle(body, signature)
    return 'OK'

import requests

def send_line_to_discord_webhook(username, avatar_url, message):
    webhook_url = config.DISCORD_WEBHOOK_URL  # 從 .env 讀取

    data = {
        "username": username,
        "avatar_url": avatar_url,
        "content": message
    }

    response = requests.post(webhook_url, json=data)
    if response.status_code != 204:
        print(f"❌ Discord Webhook 發送失敗：{response.status_code}, {response.text}")
    else:
        print(f"✅ 已同步 LINE ➜ Discord：{username}: {message}")


@handler.add(MessageEvent)
def handle_line(event):
    user_id = event.source.user_id
    message_received = event.message.text
    message_received = message_received.replace("／", "/")
    reply_token = event.reply_token
    if event.source.type == 'group':
        group_id = event.source.group_id    
        user_name = line_bot_api_old.get_group_member_profile(group_id, user_id).display_name
        user_pic = line_bot_api_old.get_group_member_profile(group_id, user_id).picture_url

    if (message_received[0] == '/'):
        line_bot_api.reply_message(reply_token, TextSendMessage(text=utils.get_reply_message(message_received)))

    msg = event.message.text
    full_msg = f"[LINE] {user_name}: {msg}"
    print(f"{full_msg}")

    telegram_bot.send_message(chat_id=config.TELEGRAM_CHAT_ID, text=full_msg)
    # loop.create_task(send_to_discord(full_msg))
    # asyncio.run_coroutine_threadsafe(send_to_discord(full_msg, user_name, user_image), discord_client.loop)
    try:
        send_line_to_discord_webhook(user_name, user_pic, msg)
    except:
        asyncio.run_coroutine_threadsafe(send_to_discord(full_msg), discord_client.loop)




async def send_to_discord(msg):
    channel = discord_client.get_channel(config.DISCORD_CHANNEL_ID)
    if channel:
        print(f"{msg}")
        await channel.send(msg)
    else:
        print("找不到 Discord 頻道，請確認 DISCORD_CHANNEL_ID 是否正確")

# async def send_to_discord(msg, user_name, user_image):
#     channel = discord_client.get_channel(config.DISCORD_CHANNEL_ID)
#     if channel:
#         print(f"{msg}")
#         await channel.send(msg, username=f"{user_name}", avatar_url=user_image)
#     else:
#         print("找不到 Discord 頻道，請確認 DISCORD_CHANNEL_ID 是否正確")

def send_to_line_group(msg):
    print(f"📤 模擬推播 LINE 群組：{msg}")
    print("⚠️ 已達每月 LINE 免費訊息上限，請考慮升級 Messaging API 方案")

    if group_id:
        try:
            line_bot_api.push_message(
                PushMessageRequest(
                    to=group_id,
                    messages=[TextMessage(text=msg)]
                )
            )
        except Exception as e:
            print(e)
    else:
        print("⚠️ 尚未偵測到 LINE 群組 ID，請先讓 BOT 加入群組並講一句話。")

@discord_client.event
async def on_ready():
    print(f"{discord_client.user}")

@discord_client.event
async def on_message(message):
    if message.author == discord_client.user:
        return
    full_msg = f"[DC] {message.author.name}: {message.content}"
    print(f"{full_msg}")
    telegram_bot.send_message(chat_id=config.TELEGRAM_CHAT_ID, text=full_msg)
    send_to_line_group(full_msg)

def start_telegram_polling():
    updater = Updater(token=config.TELEGRAM_TOKEN, use_context=True)
    dispatcher = updater.dispatcher

    def handle_telegram(update: Update, context: CallbackContext):
        msg = update.message.text
        name = update.message.from_user.first_name
        full_msg = f"[TG] {name}: {msg}"
        print(f"{full_msg}")
        # loop.create_task(send_to_discord(full_msg))
        asyncio.run_coroutine_threadsafe(send_to_discord(full_msg), discord_client.loop)
        send_to_line_group(full_msg)

    dispatcher.add_handler(MessageHandler(Filters.text & ~Filters.command, handle_telegram))
    updater.start_polling()

if __name__ == "__main__":
    print("Bot 啟動中…")
    threading.Thread(target=lambda: app.run(port=5000)).start()
    threading.Thread(target=start_telegram_polling).start()
    discord_client.run(config.DISCORD_TOKEN)
