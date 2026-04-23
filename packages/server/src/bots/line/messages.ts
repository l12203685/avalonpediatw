/**
 * Line Bot Message Templates
 */

export function createHelpMessage() {
  return {
    type: 'flex',
    altText: 'Avalon 機器人說明',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🎭 Avalon 機器人說明',
            weight: 'bold',
            size: 'xl',
            margin: 'md',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: '可用指令:',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
            color: '#999999',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: '📌 create - 建立新遊戲',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 join <房間代碼> - 加入遊戲',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 status - 查詢遊戲狀態',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 vote <approve|reject> - 投票',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 rules - 查看遊戲規則',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 roles - 查看角色介紹',
                size: 'sm',
                wrap: true,
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'message',
              label: '規則',
              text: 'rules',
            },
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'message',
              label: '建立遊戲',
              text: 'create',
            },
          },
        ],
        flex: 0,
      },
    },
  };
}

export function createRulesMessage() {
  return {
    type: 'flex',
    altText: 'Avalon 遊戲規則',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📋 Avalon 遊戲規則',
            weight: 'bold',
            size: 'xl',
            margin: 'md',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: '遊戲目標',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
            color: '#999999',
          },
          {
            type: 'text',
            text: '🔵 好人陣營:完成 3 場成功任務\n🔴 壞人陣營:完成 3 場失敗任務,或刺殺梅林',
            size: 'sm',
            wrap: true,
            margin: 'sm',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: '遊戲階段',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
            color: '#999999',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: '1️⃣ 投票階段:表決是否通過隊伍提案',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '2️⃣ 任務階段:被選中的玩家決定成功或失敗',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '3️⃣ 刺殺階段:若好人獲勝,刺客嘗試刺殺梅林',
                size: 'sm',
                wrap: true,
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'message',
              label: '查看角色',
              text: 'roles',
            },
          },
        ],
        flex: 0,
      },
    },
  };
}

export function createRolesMessage() {
  return {
    type: 'flex',
    altText: 'Avalon 角色介紹',
    contents: {
      type: 'carousel',
      contents: [
        // Merlin
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🟦 梅林',
                weight: 'bold',
                size: 'lg',
                color: '#0066ff',
              },
              {
                type: 'text',
                text: '好人陣營',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: '知道所有壞人(莫甘娜除外)。必須向刺客隱藏身份。',
                size: 'sm',
                wrap: true,
                margin: 'md',
              },
            ],
          },
        },
        // Assassin
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🟥 刺客',
                weight: 'bold',
                size: 'lg',
                color: '#ff0000',
              },
              {
                type: 'text',
                text: '壞人陣營',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: '刺殺階段殺掉梅林即可獲勝,即使好人贏得任務也一樣。',
                size: 'sm',
                wrap: true,
                margin: 'md',
              },
            ],
          },
        },
        // Percival
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🟦 派西維爾',
                weight: 'bold',
                size: 'lg',
                color: '#0066ff',
              },
              {
                type: 'text',
                text: '好人陣營',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: '知道梅林和莫甘娜是誰,但分不出誰是誰。請保護真正的梅林!',
                size: 'sm',
                wrap: true,
                margin: 'md',
              },
            ],
          },
        },
        // Morgana
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🟥 莫甘娜',
                weight: 'bold',
                size: 'lg',
                color: '#ff0000',
              },
              {
                type: 'text',
                text: '壞人陣營',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: '在派西維爾眼中偽裝成梅林。梅林仍能看出你是壞人。',
                size: 'sm',
                wrap: true,
                margin: 'md',
              },
            ],
          },
        },
      ],
    },
  };
}

export function createGameStatusMessage(status: {
  round: number;
  maxRounds: number;
  state: string;
  players: number;
  goodWins: number;
  evilWins: number;
}) {
  return {
    type: 'flex',
    altText: '遊戲狀態',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📊 遊戲狀態',
            weight: 'bold',
            size: 'xl',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '回合',
                color: '#aaaaaa',
                size: 'sm',
                flex: 1,
              },
              {
                type: 'text',
                text: `${status.round}/${status.maxRounds}`,
                wrap: true,
                color: '#666666',
                size: 'sm',
                flex: 5,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '階段',
                color: '#aaaaaa',
                size: 'sm',
                flex: 1,
              },
              {
                type: 'text',
                text: status.state,
                wrap: true,
                color: '#666666',
                size: 'sm',
                flex: 5,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '玩家人數',
                color: '#aaaaaa',
                size: 'sm',
                flex: 1,
              },
              {
                type: 'text',
                text: String(status.players),
                wrap: true,
                color: '#666666',
                size: 'sm',
                flex: 5,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '✅ 好人勝場',
                color: '#00b300',
                size: 'sm',
                flex: 2,
                weight: 'bold',
              },
              {
                type: 'text',
                text: String(status.goodWins),
                wrap: true,
                color: '#00b300',
                size: 'sm',
                flex: 5,
              },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '❌ 壞人勝場',
                color: '#ff0000',
                size: 'sm',
                flex: 2,
                weight: 'bold',
              },
              {
                type: 'text',
                text: String(status.evilWins),
                wrap: true,
                color: '#ff0000',
                size: 'sm',
                flex: 5,
              },
            ],
          },
        ],
      },
    },
  };
}

export function createQuickReplyButtons() {
  return {
    type: 'text',
    text: '歡迎來到 Avalon!請選擇你想做的事:',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '說明',
            text: 'help',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '建立遊戲',
            text: 'create',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '規則',
            text: 'rules',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '角色',
            text: 'roles',
          },
        },
      ],
    },
  };
}
