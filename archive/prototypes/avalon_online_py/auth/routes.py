import os
from flask import Blueprint, request, jsonify, render_template, redirect, url_for, flash
from flask_mail import Mail, Message
from flask_login import login_user, logout_user, login_required
from werkzeug.security import generate_password_hash, check_password_hash
from itsdangerous import URLSafeTimedSerializer
from auth.models import db, User
from dotenv import load_dotenv

auth_bp = Blueprint('auth', __name__)

# 測試 API，確認 Blueprint 是否正常運行
@auth_bp.route('/ping', methods=['GET'])
def ping():
    return jsonify({"message": "Auth 模組運行正常！"})

# 載入環境變數
load_dotenv()

auth_bp = Blueprint('auth', __name__, url_prefix='/auth')

# 設定 Flask-Mail
mail = Mail()
serializer = URLSafeTimedSerializer(os.getenv("SECRET_KEY"))

def init_mail(app):
    mail.init_app(app)

@auth_bp.route('/register', methods=['POST'])
def register():
    email = request.form.get('email')
    password = request.form.get('password')

    if User.query.filter_by(email=email).first():
        flash("信箱已被註冊，請使用其他信箱", "danger")
        return redirect(url_for('auth.register_page'))

    hashed_password = generate_password_hash(password, method='pbkdf2:sha256')

    # new_user = User(email=email, password=hashed_password, verified=False)
    new_user = User(email=email, username=email.split("@")[0], password=hashed_password, verified=False)
    db.session.add(new_user)
    db.session.commit()

    # 發送驗證郵件
    send_verification_email(new_user)

    flash("註冊成功！請查收信箱完成驗證", "success")
    return redirect(url_for('auth.login_page'))

@auth_bp.route('/verify/<token>')
def verify_email(token):
    try:
        email = serializer.loads(token, salt="email-confirm", max_age=3600)
        user = User.query.filter_by(email=email).first()

        if user:
            user.verified = True
            db.session.commit()
            flash("信箱驗證成功！請登入", "success")
            return redirect(url_for('auth.login_page'))
    except:
        flash("驗證連結已過期或無效", "danger")
        return redirect(url_for('auth.register_page'))

def send_verification_email(user):
    token = serializer.dumps(user.email, salt="email-confirm")
    verify_url = url_for('auth.verify_email', token=token, _external=True)

    msg = Message("Avalon 註冊驗證", recipients=[user.email])
    msg.body = f"請點擊下方連結驗證你的信箱：\n{verify_url}"
    mail.send(msg)

@auth_bp.route('/login', methods=['POST'])
def login():
    email = request.form.get('email')
    password = request.form.get('password')

    user = User.query.filter_by(email=email).first()

    if not user:
        flash("信箱未註冊", "danger")
        return redirect(url_for('auth.login_page'))

    if not user.verified:
        flash("請先驗證你的信箱", "warning")
        return redirect(url_for('auth.login_page'))

    if not check_password_hash(user.password, password):
        flash("密碼錯誤", "danger")
        return redirect(url_for('auth.login_page'))

    login_user(user)
    flash("登入成功", "success")
    return redirect(url_for('game.lobby'))

@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    flash("已登出", "info")
    return redirect(url_for('auth.login_page'))

@auth_bp.route('/register_page')
def register_page():
    return render_template('auth.html')

@auth_bp.route('/login_page')
def login_page():
    return render_template('auth.html')
