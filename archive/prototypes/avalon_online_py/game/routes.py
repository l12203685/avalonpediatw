# from flask import Blueprint, request, jsonify, render_template
# from flask_socketio import emit, join_room
# # from app import socketio

# # 建立 Blueprint
# game_bp = Blueprint('game', __name__, url_prefix='/game')

# # 房間列表 (暫存於伺服器記憶體，未來可改為 DB 儲存)
# rooms = {}

# # 進入遊戲大廳
# @game_bp.route('/lobby')
# def lobby():
#     return render_template('game_lobby.html')


# # 測試 API，確認 Blueprint 是否正常運行
# @game_bp.route('/ping', methods=['GET'])
# def ping():
#     return jsonify({"message": "Game 模組運行正常！"})

# @game_bp.route('/frontend')
# def frontend():
#     return render_template('game_frontend.html')

# @game_bp.route('/room/<room_name>')
# def game_room(room_name):
#     if room_name not in rooms:
#         return "房間不存在", 404
#     return render_template('game_room.html', room_name=room_name)



# # WebSocket 事件：接收聊天訊息
# def handle_chat_message(data):
#     from app import socketio  # ✅ **避免循環導入**
#     socketio.emit('chat_update', {'user': user, 'message': message}, broadcast=True)    
#     message = data.get('message', '')
#     room_name = data.get('room')  # 確保聊天室是針對房間發送的
#     user = data.get('user', request.sid)

#     if not room_name:
#         return
    
#     socketio.emit('chat_update', {'user': user, 'message': message}, room=room_name)

# # WebSocket 事件：建立遊戲房間
# def handle_create_room(data):
#     from app import socketio  # ✅ **避免循環導入**
#     room_name = data.get('room_name')
#     host_name = data.get('host_name')
    
#     if not room_name or not host_name:
#         return
    
#     rooms[room_name] = {'host': host_name, 'players': [host_name]}
#     join_room(room_name)
#     # 回傳房間 URL，讓前端可以自動進入房間
#     room_url = f"/game/room/{room_name}"
#     socketio.emit('room_created', {'room_name': room_name, 'host_name': host_name, 'room_url': room_url}, room=room_name)


# # 註冊 WebSocket 事件
# def register_events():
#     from app import socketio  # ✅ **避免循環導入**
#     socketio.on_event('chat_message', handle_chat_message)
#     socketio.on_event('create_room', handle_create_room)


# # @game_bp.route('/create_room', methods=['POST'])
# # def create_room():
# #     data = request.json
# #     return jsonify({"message": "房間已建立", "data": data})


# # # WebSocket 事件：接收聊天訊息
# # @socketio.on('chat_message')
# # def handle_chat_message(data):
# #     user = request.sid  # WebSocket 連線 ID
# #     message = data.get('message', '')
# #     emit('chat_update', {'user': user, 'message': message}, broadcast=True)

# # # WebSocket 事件：建立遊戲房間
# # @socketio.on('create_room')
# # def handle_create_room(data):
# #     room_name = data.get('room_name')
# #     host_name = data.get('host_name')
    
# #     if not room_name or not host_name:
# #         return
    
# #     rooms[room_name] = {'host': host_name, 'players': [host_name]}
# #     join_room(room_name)
# #     emit('room_created', {'room_name': room_name, 'host_name': host_name}, broadcast=True)

from flask import Blueprint, request, jsonify, render_template, redirect, url_for
from flask_socketio import emit, join_room

# 建立 Blueprint
game_bp = Blueprint('game', __name__, url_prefix='/game')

# 房間列表 (暫存於伺服器記憶體，未來可改為 DB 儲存)
rooms = {}

# 進入遊戲大廳
@game_bp.route('/lobby')
def lobby():
    return render_template('game_lobby.html')

# WebSocket 事件：接收聊天訊息
def handle_chat_message(data):
    from app import socketio  # ✅ **避免循環導入**
    room_name = data.get('room')  # 確保聊天室是針對房間發送的
    user = data.get('user', request.sid)
    message = data.get('message', '')

    if not room_name:
        return
    
    socketio.emit('chat_update', {'user': user, 'message': message}, room=room_name)

# WebSocket 事件：建立遊戲房間
def handle_create_room(data):
    from app import socketio  # ✅ **避免循環導入**
    room_name = data.get('room_name')
    host_name = data.get('host_name')
    
    if not room_name or not host_name:
        return
    
    rooms[room_name] = {'host': host_name, 'players': [host_name]}
    join_room(room_name)
    
    # 讓前端自動跳轉到遊戲房間
    socketio.emit('room_created', {'room_name': room_name, 'host_name': host_name, 'room_url': f'/game/room/{room_name}'}, broadcast=True)

# 註冊 WebSocket 事件
def register_events():
    from app import socketio  # ✅ **避免循環導入**
    socketio.on_event('chat_message', handle_chat_message)
    socketio.on_event('create_room', handle_create_room)

# 進入遊戲房間
@game_bp.route('/room/<room_name>')
def game_room(room_name):
    if room_name not in rooms:
        return "房間不存在", 404
    return render_template('game_room.html', room_name=room_name)
