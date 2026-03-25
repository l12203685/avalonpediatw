/**
 * Line Bot Message Templates
 */

export function createHelpMessage() {
  return {
    type: 'flex',
    altText: 'Avalon Bot Help',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🎭 Avalon Bot Help',
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
            text: 'Available Commands:',
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
                text: '📌 create - Create a new game',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 join <room-id> - Join a game',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 status - Check game status',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 vote <approve|reject> - Cast your vote',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 rules - View game rules',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '📌 roles - View role descriptions',
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
              label: 'Rules',
              text: 'rules',
            },
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'message',
              label: 'Create Game',
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
    altText: 'Avalon Rules',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📋 Avalon Rules',
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
            text: 'Game Objective',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
            color: '#999999',
          },
          {
            type: 'text',
            text: '🔵 Good: Complete 3 successful quests\n🔴 Evil: Complete 3 failed quests OR assassinate Merlin',
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
            text: 'Game Phases',
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
                text: '1️⃣ Voting: Vote to approve/reject team proposal',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '2️⃣ Quest: Selected players choose success/fail',
                size: 'sm',
                wrap: true,
              },
              {
                type: 'text',
                text: '3️⃣ Discussion: If good wins, assassin tries to kill Merlin',
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
              label: 'View Roles',
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
    altText: 'Avalon Roles',
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
                text: '🟦 Merlin',
                weight: 'bold',
                size: 'lg',
                color: '#0066ff',
              },
              {
                type: 'text',
                text: 'Good Team',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: 'Knows all evil players (except Morgana). Must hide your identity from the assassin.',
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
                text: '🟥 Assassin',
                weight: 'bold',
                size: 'lg',
                color: '#ff0000',
              },
              {
                type: 'text',
                text: 'Evil Team',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: 'Kill Merlin in the assassination phase to win, even if good is winning quests.',
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
                text: '🟦 Percival',
                weight: 'bold',
                size: 'lg',
                color: '#0066ff',
              },
              {
                type: 'text',
                text: 'Good Team',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: 'Knows who Merlin and Morgana are, but not which is which. Protect the real Merlin!',
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
                text: '🟥 Morgana',
                weight: 'bold',
                size: 'lg',
                color: '#ff0000',
              },
              {
                type: 'text',
                text: 'Evil Team',
                size: 'xs',
                color: '#999999',
                margin: 'md',
              },
              {
                type: 'text',
                text: 'Appears as good to Merlin. Merlin cannot see you as evil.',
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
    altText: 'Game Status',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📊 Game Status',
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
                text: 'Round',
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
                text: 'State',
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
                text: 'Players',
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
                text: '✅ Good Wins',
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
                text: '❌ Evil Wins',
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
    text: 'Welcome to Avalon! What would you like to do?',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'Help',
            text: 'help',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'Create Game',
            text: 'create',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'Rules',
            text: 'rules',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'Roles',
            text: 'roles',
          },
        },
      ],
    },
  };
}
