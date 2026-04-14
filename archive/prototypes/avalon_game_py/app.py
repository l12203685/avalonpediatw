from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__, template_folder="templates")  # 確保 Flask 知道模板位置
socketio = SocketIO(app, cors_allowed_origins="*")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/game/<room_id>")
def game(room_id):
    return render_template("game.html", room_id=room_id)

if __name__ == "__main__":
    socketio.run(app, debug=True)
