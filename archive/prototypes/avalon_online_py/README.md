# Avalon Online

A web-based version of the social deduction game *Avalon*, implemented using Flask and WebSocket.

## Installation

1. Clone the repository:
   ```sh
   git clone <repository-url>
   cd avalon_online
   ```

2. Create a virtual environment and activate it:
   ```sh
   python -m venv venv
   source venv/bin/activate  # On Windows use: venv\Scripts\activate
   ```

3. Install dependencies:
   ```sh
   pip install -r requirements.txt
   ```

4. Set up the database:
   ```sh
   flask db upgrade
   ```

5. Run the application:
   ```sh
   python app.py
   ```

## Features

- User authentication with email verification
- Real-time game interactions using WebSockets
- Discord integration for chat synchronization
- Game history tracking

## License

MIT License

# Avalon Online 遊戲伺服器

本專案為線上 **Avalon 阿瓦隆** 遊戲伺服器，支援 **Flask + WebSocket** 即時通訊，並同步 **Discord 聊天**。

## 📌 主要功能
- **多玩家線上遊戲**：支援房間管理、遊戲角色分配、投票流程。
- **WebSocket 即時互動**：玩家加入、投票、遊戲進度均可即時更新。
- **Discord Webhook 同步**：遊戲內訊息可同步發送到 Discord 頻道。
- **遊戲流程管理**：支援派票、投票、暗殺、任務成功與失敗。
- **計時機制**：自動管理隊伍選擇時間、投票時間、刺客暗殺時間。

## 📦 環境設定
### 1️⃣ 安裝相依套件
```bash
pip install -r requirements.txt
```

### 2️⃣ 設定環境變數 `.env`
建立 `.env` 檔案，內容如下：
```
SECRET_KEY=your_secret_key
DATABASE_URL=sqlite:///avalon.db
DISCORD_WEBHOOK_URL=your_discord_webhook_url
```

### 3️⃣ 初始化資料庫
```bash
flask db upgrade
```

### 4️⃣ 啟動伺服器
```bash
flask run
```

## 🚀 API 端點
### 🎮 遊戲管理 API
| 方法 | 端點 | 描述 |
|------|------|------|
| POST | `/create_room` | 創建新遊戲房間 |
| POST | `/join_room` | 玩家加入房間 |
| POST | `/start_game` | 開始遊戲並分配角色 |
| POST | `/vote` | 玩家投票 |

### 🔄 WebSocket 事件
| 事件 | 描述 |
|------|------|
| `join` | 玩家加入遊戲房間 |
| `start_game` | 遊戲開始並通知所有玩家 |
| `vote` | 玩家投票事件 |
| `assassinate` | 刺客暗殺事件 |

## 🎭 遊戲角色
- 梅林（Merlin）
- 派西維爾（Percival）
- 忠臣（Loyal Servant）
- 刺客（Assassin）
- 莫甘娜（Morgana）
- 奧伯倫（Oberon）
- 莫德雷德爪牙（Minion of Mordred）

## 🎯 目標
本專案可作為線上阿瓦隆遊戲的基礎，未來可擴展 **前端 UI**、**Discord Bot 整合** 等功能。

---

✨ **開發者：** 你的名字 | 版本：1.0.0

