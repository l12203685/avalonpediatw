"""This python file will host discord bot."""
import json
import time
from datetime import datetime, timezone, timedelta

import discord
import zmq
from discord import File
from discord import app_commands
from discord.ext import commands

import utilities as utils

from discord import Embed
from selenium import webdriver
from selenium.webdriver.common.by import By

import asyncio
import re
import os

TAIPEI = timezone(timedelta(hours=8))

intents = discord.Intents.default()
intents.message_content = True
print(intents)
client = commands.Bot(command_prefix="!", intents=discord.Intents.all())

context = zmq.Context()
socket = context.socket(zmq.PUB)
socket.bind("tcp://*:5555")

supported_image_format = ('.jpg', '.png', '.jpeg')
supported_video_format = '.mp4'
supported_audio_format = ('.m4a', '.wav', '.mp3', '.aac', '.flac', '.ogg', '.opus')

config = utils.read_config()


user_sessions = {}  # user_id: driver
last_date = None
event_counts = {}

@client.event
async def on_ready():
    """Initialize discord bot."""
    print(f'{client.user} 已登入 Discord, Bot is ready')
    try:
        synced = await client.tree.sync()
        print(f"Synced {synced} commands.")
    except Exception as e:
        print(f"Failed to sync commands: {e}")


# @client.tree.command(name="about", description="關於此機器人, 查看目前同步中的服務")
# @app_commands.describe()
# async def about(interaction: discord.Interaction):
#     subscribed_info = utils.get_subscribed_info_by_discord_channel_id(str(interaction.channel.id))
#     if subscribed_info:
#         sync_info = f"=======================================\n" \
#                     f"Discord頻道：{subscribed_info['discord_channel_name']}\n" \
#                     f"Line群組      ：{subscribed_info['line_group_name']}\n" \
#                     f"=======================================\n"
#     else:
#         sync_info = f"尚未綁定任何Line群組！\n"
#     all_commands = await client.tree.fetch_commands()
#     help_command = discord.utils.get(all_commands, name="help")
#     embed_message = discord.Embed(title="Discord <> Line 訊息同步機器人",
#                                   description=f"一個協助你同步雙平台訊息的免費服務\n\n"
#                                               f"目前同步中的服務：\n"
#                                               f"{sync_info}\n"
#                                               f"此專案由 [樂弟](https://github.com/HappyGroupHub) 開發，"
#                                               f"並開源歡迎所有人共\n同維護。"
#                                               f"你可以使用指令 {help_command.mention} 了解如何\n使用此機器人\n",
#                                   color=0x2ecc71)
#     embed_message.set_author(name=client.user.name, icon_url=client.user.avatar)
#     embed_message.add_field(name="作者", value="LD", inline=True)
#     embed_message.add_field(name="架設者", value=config['bot_owner'], inline=True)
#     embed_message.add_field(name="版本", value="v0.2.1", inline=True)
#     await interaction.response.send_message(embed=embed_message, view=AboutCommandView())

@client.event
async def on_message(message):
    """Handle message event."""
    now = datetime.now()
    print(now.strftime('%Y%m%d %H:%M:%S'), message.author, message.content)

    if message.author == client.user:
        return
    discord_webhook_bot_ids = utils.get_discord_webhook_bot_ids()
    if message.author.id in discord_webhook_bot_ids:
        return
    subscribed_discord_channels = utils.get_subscribed_discord_channels()
    message_channel_id = str(message.channel.id)
    message_channel_name = message.channel.name
    if message.channel.id not in subscribed_discord_channels:
        message_channel_id = '1132901301802504242'
    subscribed_info = utils.get_subscribed_info_by_discord_channel_id(message_channel_id)
    # subscribed_info = utils.get_subscribed_info_by_discord_channel_id(str(message.channel.id))
    sub_num = subscribed_info['sub_num']
    author = f'[{message.author.display_name}]'
    message_channel_id_exclude = subscribed_info['message_channel_id_exclude']
    discord_roles = subscribed_info['discord_roles']
    if (message_channel_id is not None and (int(message.channel.id) not in message_channel_id_exclude.values())):
        if message.attachments:
            for attachment in message.attachments:
                if attachment.filename.endswith(supported_image_format):
                    content = message.clean_content
                    image_file_path = utils.download_file_from_url(subscribed_info['folder_name'], attachment.url, attachment.filename)
                    send_to_line_bot('image', sub_num, author, content, image_url=attachment.url, msg_time=now.strftime('%H:%M:%S'), ch_name=message_channel_name)

                if attachment.filename.endswith(supported_video_format):
                    video_file_path = utils.download_file_from_url(subscribed_info['folder_name'], attachment.url, attachment.filename)
                    thumbnail_path = utils.generate_thumbnail(video_file_path)

                    # Send thumbnail to discord, get url, and delete the message.
                    thumbnail_message = await message.channel.send(thumbnail_path, file=File(thumbnail_path))
                    thumbnail_url = thumbnail_message.attachments[0].url
                    await thumbnail_message.delete()

                    content = message.clean_content
                    send_to_line_bot('video', sub_num, author, content, video_url=attachment.url, thumbnail_url=thumbnail_url, msg_time=now.strftime('%H:%M:%S'), ch_name=message_channel_name)
                if attachment.filename.endswith(supported_audio_format):
                    audio_file_path = utils.download_file_from_url(sub_num, attachment.url, attachment.filename)
                    if not attachment.filename.endswith('.m4a'):
                        audio_file_path = utils.convert_audio_to_m4a(audio_file_path)
                    audio_duration = utils.get_audio_duration(audio_file_path)
                    content = message.clean_content
                    send_to_line_bot('audio', sub_num, author, content, audio_url=attachment.url, audio_duration=audio_duration, msg_time=now.strftime('%H:%M:%S'), ch_name=message_channel_name)
                else:
                    # TODO(LD): Handle other file types.
                    pass
        else:
            content = message.clean_content
            for k, v in discord_roles.items():
                content = content.replace(k, v)
            # 傳送文字到 line_bot（只入佇列，等待 LINE 的 reply 觸發）
            if content.strip():
                send_to_line_bot('text', sub_num, author, content, msg_time=now.strftime('%H:%M:%S'), ch_name=message_channel_name)

    await client.process_commands(message)

def send_to_line_bot(msg_type, sub_num, author, message, video_url=None, thumbnail_url=None, audio_url=None, audio_duration=None, image_url=None, msg_time=None, ch_name=None):
    data = {
        'msg_type': msg_type,
        'sub_num': sub_num,
        'author': author,
        'message': message
    }
    if video_url: data['video_url'] = video_url
    if thumbnail_url: data['thumbnail_url'] = thumbnail_url
    if audio_url: data['audio_url'] = audio_url
    if audio_duration is not None: data['audio_duration'] = audio_duration
    if image_url: data['image_url'] = image_url
    if msg_time: data['msg_time'] = msg_time
    if ch_name: data['ch_name'] = ch_name 

    json_data = json.dumps(data, ensure_ascii=False)
    for i in range(2):
        if i == 1:
            socket.send_json(json_data)
        time.sleep(1)

client.run(config.get('discord_bot_token'))
