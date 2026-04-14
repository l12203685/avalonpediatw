"""This python file will handle line webhooks."""
import json
from threading import Thread

import zmq
from discord import SyncWebhook, File
from flask import Flask, request, abort
from flask.logging import create_logger
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
# from linebot.models import MessageEvent, TextMessage, ImageMessage, VideoMessage, VideoSendMessage, TextSendMessage, AudioMessage, AudioSendMessage
from linebot.models import MessageEvent, StickerMessage, StickerSendMessage, TextMessage, TextSendMessage, ImageMessage, ImageSendMessage, VideoMessage, VideoSendMessage, AudioMessage, AudioSendMessage, FlexSendMessage

import utilities as utils

from collections import defaultdict, deque
import threading

# per-LINE chat 的待送佇列與鎖
_PENDING = defaultdict(deque)      # key = group_id, value = deque[Message]
_LOCKS = defaultdict(threading.Lock)

def _enqueue(group_id, msg_objs):
    q = _PENDING[group_id]
    for m in msg_objs:
        q.append(m)

def _flush_with_reply(group_id, reply_token, prepend_msgs=None):
    """
    用當前 reply_token 回覆，把佇列中「全部內容」壓縮打包成 <=5 個物件：
    1) prepend 訊息（如指令回覆）
    2) 合併文字（最多 2 則，各<=5000字）
    3) 圖片 Flex 畫廊（最多10張）
    4) 影音連結清單（1 則）
    """
    # 取出所有待送
    q = _PENDING[group_id]
    items = []
    while q:
        items.append(q.popleft())

    if not items and not prepend_msgs:
        return False

    # 分類
    texts, images, videos, audios = [], [], [], []
    def to_text(m):  # 取 TextSendMessage 的字串
        try:
            return getattr(m, 'text', '')
        except Exception:
            return ''

    for m in items:
        t = getattr(m, 'type', None) or m.__class__.__name__
        if isinstance(m, TextSendMessage):
            texts.append(to_text(m))
        elif isinstance(m, ImageSendMessage):
            images.append({
                "original": m.original_content_url,
                "preview": m.preview_image_url or m.original_content_url
            })
        elif isinstance(m, VideoSendMessage):
            videos.append({
                "url": m.original_content_url,
                "preview": m.preview_image_url or m.original_content_url
            })
        elif isinstance(m, AudioSendMessage):
            audios.append({
                "url": m.original_content_url,
                "duration": getattr(m, 'duration', None)
            })
        else:
            # 不識別的就當文字處理
            s = to_text(m)
            if s:
                texts.append(s)

    # 文字合併（最多 2 則，每則 <= 5000 字）
    def chunk_text(s, maxlen=4900):
        # 留點餘裕避免 emoji/UTF-16 邊界
        chunks, cur = [], []
        length = 0
        for line in s.splitlines():
            add = (line + "\n")
            if length + len(add) > maxlen:
                chunks.append("".join(cur).rstrip())
                cur, length = [add], len(add)
            else:
                cur.append(add)
                length += len(add)
        if cur:
            chunks.append("".join(cur).rstrip())
        return chunks

    text_msgs = []
    if texts:
        joined = "\n".join(texts)
        for seg in chunk_text(joined)[:2]:
            if seg.strip():
                text_msgs.append(TextSendMessage(text=seg))

    # 圖片 Flex（最多 10 張）
    flex_msg = None
    if images:
        bubbles = []
        for im in images[:10]:
            bubbles.append({
                "type": "bubble",
                "size": "micro",
                "hero": {
                    "type": "image",
                    "url": im["preview"],
                    "size": "full",
                    "aspectRatio": "1:1",
                    "action": {"type": "uri", "uri": im["original"]}
                }
            })
        carousel = {"type": "carousel", "contents": bubbles}
        flex_msg = FlexSendMessage(alt_text="圖片彙整", contents=carousel)

    # 影音清單（文字）
    av_lines = []
    if videos:
        av_lines.append("📺 影片：")
        for v in videos:
            av_lines.append(f"- {v['url']}")
    if audios:
        av_lines.append("🎧 音訊：")
        for a in audios:
            if a.get("duration"):
                ms = int(a["duration"])
                sec = ms // 1000
                av_lines.append(f"- {a['url']} ({sec}s)")
            else:
                av_lines.append(f"- {a['url']}")
    av_msg = TextSendMessage(text="\n".join(av_lines)) if av_lines else None

    # 組裝最多 5 個物件（prepend 放最前）
    msgs = []
    if prepend_msgs:
        # 若 prepend 很多，保守起見只拿前 2 則，避免擠爆
        msgs.extend(prepend_msgs[:2])

    msgs.extend(text_msgs)                 # 0~2 則
    if flex_msg:
        msgs.append(flex_msg)              # +1 則
    if av_msg and len(msgs) < 5:
        msgs.append(av_msg)                # +1 則

    # 保險：仍不可超過 5
    msgs = msgs[:5]

    if msgs:
        line_bot_api.reply_message(reply_token, msgs)
        return True
    return False


config = utils.read_config()
line_bot_api = LineBotApi(config['line_channel_access_token'])
handler = WebhookHandler(config['line_channel_secret'])

app = Flask(__name__)
log = create_logger(app)

context = zmq.Context()
socket = context.socket(zmq.SUB)
socket.connect("tcp://localhost:5555")
socket.setsockopt_string(zmq.SUBSCRIBE, '')


@app.route("/callback", methods=['POST'])
def callback():
    """Callback function for line webhook."""

    # get X-Line-Signature header value
    signature = request.headers['X-Line-Signature']

    # get request body as text
    body = request.get_data(as_text=True)
    log.info("Request body: %s", body)

    # handle webhook body
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        print("Invalid signature. Please check your channel access token/channel secret.")
        abort(400)

    return 'OK'

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    """Handle message event."""
    if event.source.type == 'user':
        message_received = event.message.text
        message_received = message_received.replace("／", "/")
        user_id = event.source.user_id
        reply_token = event.reply_token
        subscribed_line_channels = utils.get_subscribed_line_channels()
        if (message_received[0] == '/'):
            line_bot_api.reply_message(reply_token, TextSendMessage(text=utils.get_reply_message(message_received)))
    if event.source.type == 'group':
        message_received = event.message.text.replace("／", "/")
        user_id = event.source.user_id
        group_id = event.source.group_id
        reply_token = event.reply_token
        subscribed_line_channels = utils.get_subscribed_line_channels()

        if message_received.startswith('/'):
            # 指令回覆 + 併送待送佇列（最多共 5 則）
            ack = TextSendMessage(text=utils.get_reply_message(message_received))
            _flush_with_reply(group_id, reply_token, prepend_msgs=[ack])
            return

        # 一般訊息：照舊轉到 Discord（webhook）
        if group_id in subscribed_line_channels:
            subscribed_info = utils.get_subscribed_info_by_line_group_id(group_id)
            author_prof = line_bot_api.get_group_member_profile(group_id, user_id)
            discord_webhook = SyncWebhook.from_url(subscribed_info['discord_channel_webhook'])
            discord_webhook.send(
                message_received,
                username=f"{author_prof.display_name}",
                avatar_url=author_prof.picture_url
            )

        # 嘗試用這次的 reply_token flush DC→LINE 待送內容
        _flush_with_reply(group_id, reply_token)


@handler.add(MessageEvent, message=ImageMessage)
def handle_image(event):
    """Handle image message event."""
    if event.source.type == 'user':
        return
    if event.source.type == 'group':
        user_id = event.source.user_id
        group_id = event.source.group_id
        subscribed_line_channels = utils.get_subscribed_line_channels()
        if group_id in subscribed_line_channels:
            subscribed_info = utils.get_subscribed_info_by_line_group_id(group_id)
            author = line_bot_api.get_group_member_profile(group_id, user_id).display_name
            author_image = line_bot_api.get_group_member_profile(group_id, user_id).picture_url
            source = line_bot_api.get_message_content(event.message.id)
            file_path = utils.download_file_from_line(subscribed_info['folder_name'], source, event.message.type)
            discord_webhook = SyncWebhook.from_url(subscribed_info['discord_channel_webhook'])
            discord_webhook.send(file=File(file_path), username=f"{author}", avatar_url=author_image)
    reply_token = event.reply_token
    _flush_with_reply(group_id, reply_token)


@handler.add(MessageEvent, message=VideoMessage)
def handle_video(event):
    """Handle video message event."""
    if event.source.type == 'user':
        return
    if event.source.type == 'group':
        user_id = event.source.user_id
        group_id = event.source.group_id
        subscribed_line_channels = utils.get_subscribed_line_channels()
        if group_id in subscribed_line_channels:
            subscribed_info = utils.get_subscribed_info_by_line_group_id(group_id)
            author = line_bot_api.get_group_member_profile(group_id, user_id).display_name
            author_image = line_bot_api.get_group_member_profile(group_id, user_id).picture_url
            source = line_bot_api.get_message_content(event.message.id)
            file_path = utils.download_file_from_line(subscribed_info['folder_name'], source, event.message.type)
            discord_webhook = SyncWebhook.from_url(subscribed_info['discord_channel_webhook'])
            discord_webhook.send(file=File(file_path), username=f"{author}", avatar_url=author_image)
    reply_token = event.reply_token
    _flush_with_reply(group_id, reply_token)



@handler.add(MessageEvent, message=AudioMessage)
def handle_audio(event):
    """Handle audio message event."""
    if event.source.type == 'user':
        return
    if event.source.type == 'group':
        user_id = event.source.user_id
        group_id = event.source.group_id
        subscribed_line_channels = utils.get_subscribed_line_channels()
        if group_id in subscribed_line_channels:
            subscribed_info = utils.get_subscribed_info_by_line_group_id(group_id)
            author = line_bot_api.get_group_member_profile(group_id, user_id).display_name
            author_image = line_bot_api.get_group_member_profile(group_id, user_id).picture_url
            source = line_bot_api.get_message_content(event.message.id)
            file_path = utils.download_file_from_line(subscribed_info['folder_name'], source, event.message.type)
            discord_webhook = SyncWebhook.from_url(subscribed_info['discord_channel_webhook'])
            discord_webhook.send(file=File(file_path), username=f"{author}", avatar_url=author_image)
    reply_token = event.reply_token
    _flush_with_reply(group_id, reply_token)

def receive_from_discord():
    """Receive from discord bot (DC→LINE)，改成只入佇列，等下一個 LINE 事件用 reply 送出。"""
    while True:
        received = socket.recv_json()
        received = json.loads(received)

        subscribed_info = utils.get_subscribed_info_by_sub_num(received['sub_num'])
        group_id = subscribed_info['line_group_id']

        msg_type = received.get('msg_type')
        msg_time = received.get('msg_time')
        msg_ch = received.get('ch_name') or "-"
        author = received.get('author', '').strip()
        text = received.get('message', '').strip()

        batch = []

        if msg_type == 'text':
            # 文字：前面加上作者
            display = f"[{msg_time}][{msg_ch}]{author}: {text}" if author else text
            batch.append(TextSendMessage(text=display))

        elif msg_type == 'image':
            url = received.get('image_url')
            if url:
                batch.append(ImageSendMessage(original_content_url=url, preview_image_url=url))
            if text:
                batch.append(TextSendMessage(text=f"[{msg_time}][{msg_ch}]{author}: {text}" if author else text))

        elif msg_type == 'video':
            v = received.get('video_url')
            thumb = received.get('thumbnail_url') or v
            if v:
                batch.append(VideoSendMessage(original_content_url=v, preview_image_url=thumb))
            if text:
                batch.append(TextSendMessage(text=f"[{msg_time}][{msg_ch}]{author}: {text}" if author else text))

        elif msg_type == 'audio':
            a = received.get('audio_url')
            dur = received.get('audio_duration') or 0
            if a:
                batch.append(AudioSendMessage(original_content_url=a, duration=dur))
            if text:
                batch.append(TextSendMessage(text=f"[{msg_time}][{msg_ch}]{author}: {text}" if author else text))

        # 入佇列（可能超過 5 則，會在下一次 LINE 事件時分批送出）
        if batch:
            _enqueue(group_id, batch)


thread = Thread(target=receive_from_discord)
thread.start()

if __name__ == "__main__":
    app.run()
