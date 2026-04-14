# import os
# from flask import Flask, render_template, redirect, url_for
# from flask_socketio import SocketIO
# from flask_login import LoginManager, current_user
# from flask_migrate import Migrate

# from config import config
# from auth.models import db, User
# from auth.routes import auth_bp, init_mail
# from chat.routes import chat_bp
# from history.routes import history_bp
# from game.routes import game_bp, register_events
# from auth.email import mail, init_mail

# from flask_mail import Mail

# mail = Mail()

# # 初始化 Flask 套件
# socketio = SocketIO()
# login_manager = LoginManager()
# login_manager.login_view = 'auth.login'
# migrate = Migrate()

# @login_manager.user_loader
# def load_user(user_id):
#     return User.query.get(int(user_id))

# def create_app(config_name='default'):
#     app = Flask(__name__)

#     app.config.from_object(config[config_name])

#     # 初始化擴充功能
#     db.init_app(app)
#     mail.init_app(app)
#     socketio.init_app(app, cors_allowed_origins="*")
#     login_manager.init_app(app)
#     migrate.init_app(app, db)
#     init_mail(app)

#     # 註冊 Blueprint
#     app.register_blueprint(auth_bp)
#     app.register_blueprint(game_bp)
#     app.register_blueprint(chat_bp)
#     app.register_blueprint(history_bp)

#     register_events()

#     @app.route('/')
#     def index():
#         if current_user.is_authenticated:
#             return redirect(url_for('game.lobby'))
#         return redirect(url_for('auth.login'))

#     # 錯誤處理
#     @app.errorhandler(404)
#     def page_not_found(e):
#         return render_template('404.html'), 404

#     @app.errorhandler(500)
#     def server_error(e):
#         return render_template('500.html'), 500

#     return app

# if __name__ == '__main__':
#     app_env = os.environ.get('FLASK_ENV', 'development')
#     app = create_app(app_env)
#     socketio.run(app, debug=app.config['DEBUG'], host="127.0.0.1", port=5000)

import os
from flask import Flask, render_template, redirect, url_for
from flask_socketio import SocketIO
from flask_login import LoginManager, current_user
from flask_migrate import Migrate
from flask_mail import Mail

from config import config
from auth.models import db, User
from auth.routes import auth_bp, init_mail
from chat.routes import chat_bp
from history.routes import history_bp
from game.routes import game_bp, register_events

# 初始化 Flask 擴充功能
socketio = SocketIO()
login_manager = LoginManager()
login_manager.login_view = 'auth.login'
migrate = Migrate()
mail = Mail()

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

def create_app(config_name='default'):
    app = Flask(__name__)
    app.config.from_object(config[config_name])

    # 初始化擴充功能
    db.init_app(app)
    mail.init_app(app)
    socketio.init_app(app, cors_allowed_origins="*")
    login_manager.init_app(app)
    migrate.init_app(app, db)
    init_mail(app)

    # 註冊 Blueprint
    app.register_blueprint(auth_bp)
    app.register_blueprint(game_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(history_bp)

    # 確保 WebSocket 事件在 `socketio.init_app(app)` 之後註冊
    register_events()

    @app.route('/')
    def index():
        if current_user.is_authenticated:
            return redirect(url_for('game.lobby'))
        return redirect(url_for('auth.login'))

    # 錯誤處理
    @app.errorhandler(404)
    def page_not_found(e):
        return render_template('404.html'), 404

    @app.errorhandler(500)
    def server_error(e):
        return render_template('500.html'), 500

    return app

if __name__ == '__main__':
    app_env = os.environ.get('FLASK_ENV', 'development')
    app = create_app(app_env)
    
    # 確保 `app.debug` 正確設置
    debug_mode = app.config.get('DEBUG', True)

    socketio.run(app, debug=debug_mode, host="127.0.0.1", port=5000)
