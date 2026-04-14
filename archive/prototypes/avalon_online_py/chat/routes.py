from flask import Blueprint, request, jsonify

chat_bp = Blueprint('chat', __name__)

# 測試 API，確認 Blueprint 是否正常運行
@chat_bp.route('/ping', methods=['GET'])
def ping():
    return jsonify({"message": "Chat 模組運行正常！"})
