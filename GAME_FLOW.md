# Avalon Game Flow - Phase 2.1 Implementation

## Overview
This document describes the complete game flow implemented in Phase 2.1, including all game phases and their interactions.

## Game Phases

### 1. Voting Phase (投票階段)
**State**: `voting`

**Flow**:
1. Backend assigns roles and initializes game
2. Leader is determined by `room.leaderIndex` (starts at 0)
3. Frontend shows `TeamSelectionPanel` to current leader
4. Other players see `VotePanel` where they vote to approve/reject the team

**Frontend Components**:
- `TeamSelectionPanel.tsx` - Leader selects quest team members
- `VotePanel.tsx` - Players vote approve/reject

**Socket.IO Events**:
- Client: `game:select-quest-team` (leader selects team)
- Client: `game:vote` (other players vote)
- Server broadcasts: `game:state-updated`

**Success Condition**:
- More approve votes than reject votes → Advance to Quest Phase
- Move to next voting round with rotated leader

**Failure Condition** (3 failed votes):
- Evil wins immediately

---

### 2. Quest Phase (任務階段)
**State**: `quest`

**Prerequisites**:
- Team has been selected and approved
- `room.questTeam` contains selected player IDs

**Flow**:
1. Selected team members now vote on mission success/failure
2. Frontend shows `QuestPanel` to team members
3. Non-team members see a waiting screen

**Frontend Components**:
- `QuestPanel.tsx` - Team members vote success/fail
- Game board shows waiting status for other players

**Socket.IO Events**:
- Client: `game:submit-quest-vote` (team member votes)
- Server broadcasts: `game:state-updated`

**Resolution Logic** (`resolveQuestPhase`):
- Count fail votes: 1 fail = quest fails (standard Avalon rules)
- Add result to `room.questResults`
- Check win conditions:
  - Good wins 3 quests → Advance to Discussion Phase
  - Evil wins 3 quests → Game ends (Evil wins)
  - Otherwise → Return to Voting Phase with rotated leader

---

### 3. Discussion Phase (討論階段)
**State**: `discussion`

**Prerequisites**:
- Good team has won 3 quests
- Assassin is still alive

**Flow**:
1. Assassin chooses who they think is Merlin
2. Frontend shows assassination buttons to assassin
3. Other players see waiting screen with hint about assassination

**Frontend Components**:
- Assassination target selection buttons for assassin
- Waiting message for other players

**Socket.IO Events**:
- Client: `game:assassinate` (assassin targets someone)
- Server broadcasts: `game:state-updated` and `game:ended`

**Resolution Logic** (`resolveAssassination`):
- If target is Merlin → Evil wins
- If target is not Merlin → Good wins
- If timeout (30s) with no assassination → Good wins

---

### 4. Game End Phase (遊戲結束)
**State**: `ended`

**Display**:
- Winner announcement (Good or Evil)
- Final roles revealed
- Player statistics

---

## Data Structures

### Room Updates During Game
```typescript
// Game initialization
room.state = 'voting'
room.currentRound = 1
room.leaderIndex = 0
room.questTeam = []
room.questResults = []
room.failCount = 0

// After each voting phase
room.leaderIndex++ // Rotated by GameEngine
room.failCount++ // If vote failed

// After quest phase
room.questResults.push('success' | 'fail')
room.currentRound++

// After game end
room.state = 'ended'
room.evilWins = true | false
```

### Leader Determination
```typescript
// Frontend
const leaderIndex = room.leaderIndex
const playerIds = Object.keys(room.players)
const leaderId = playerIds[leaderIndex % playerIds.length]
const isCurrentPlayerLeader = currentPlayer.id === leaderId
```

---

## Timeout Management

### Voting Phase
- **Duration**: 30 seconds
- **On Timeout**: Auto-vote as reject for all unvoted players
- **Cleaned Up**: Yes, explicitly set to null

### Quest Phase
- **Duration**: 30 seconds
- **On Timeout**: Auto-vote as success for all unvoted team members
- **Cleaned Up**: Yes, explicitly set to null

### Assassination Phase
- **Duration**: 30 seconds
- **On Timeout**: Good wins (assassin failed to choose)
- **Cleaned Up**: Yes, explicitly set to null

### Cleanup on Game End
- All timeouts explicitly cleared in `GameEngine.cleanup()`
- Called when room is destroyed

---

## Error Handling

### Validation at Each Phase
1. **Team Selection**:
   - Only leader can select
   - Correct team size validation
   - All players exist in room

2. **Voting**:
   - Correct game state
   - Player exists in room
   - Player hasn't voted yet
   - Rate limiting (1 vote/sec max)

3. **Quest Vote**:
   - Correct game state
   - Player is in quest team
   - Player hasn't voted yet

4. **Assassination**:
   - Correct game state
   - Assassin is in room
   - Target is valid player

---

## Frontend State Management

### Game Store Integration
The `useGameStore` hook provides:
- `room` - Current game room state
- `currentPlayer` - Current player object
- `updateRoom()` - Update room state from socket events
- `setGameState()` - Update game phase

### Socket Events Handled
- `game:state-updated` - Room state changed
- `game:started` - Game has begun
- `game:ended` - Game is over

---

## Testing Scenarios

### Scenario 1: 5-Player Game (Basic Flow)
1. Create room with 5 players
2. Start game (roles: Merlin, Percival, Loyal, Assassin, Morgana)
3. Vote phase: Approve team [Merlin, Loyal]
4. Quest phase: Team votes Success
5. Vote phase: Approve team [Loyal, Assassin]
6. Quest phase: Team votes Fail (Assassin votes fail)
7. Vote phase: Approve team [Merlin, Percival]
8. Quest phase: Team votes Success
9. Discussion: Assassin guesses wrong → Good wins

### Scenario 2: 3 Failed Votes
1. Start game
2. Voting round 1: Reject (leader rotates)
3. Voting round 2: Reject (leader rotates)
4. Voting round 3: Reject (leader rotates)
5. Voting round 4 (failCount = 3): Game ends → Evil wins

### Scenario 3: Evil Wins by Quests
1. Start game
2. Quest 1: Fail
3. Vote, Quest 2: Fail
4. Vote, Quest 3: Fail (failCount = 3)
5. Game ends → Evil wins

---

## Known Limitations & Future Work

### Phase 2.1 Scope
- ✅ Core game logic fully implemented
- ✅ Timeout handling with proper cleanup
- ✅ Leader rotation and validation
- ❌ UI Polish (animations, sounds)
- ❌ Comprehensive testing suite
- ❌ Game replay/history

### Phase 2.2 Tasks
- Build Discussion Panel UI
- Add player action notifications
- Implement game history recording
- Add statistics calculation
- Create room lobby interface

### Phase 3 Tasks
- Real-time synchronization optimization
- Disconnection handling improvements
- Game state persistence
- Performance optimization

---

## Debug Tips

### Enable Logging
The `GameEngine` logs all major events as JSON:
```json
{"timestamp":"2024-01-01T12:00:00Z","roomId":"room-123","event":"voting_resolved","approvals":3,"rejections":2,"result":"approved"}
```

### Common Issues

1. **Game stuck in voting phase**
   - Check that team is selected before voting ends
   - Verify leaderIndex is correct in room state

2. **Quest vote not working**
   - Ensure player is in room.questTeam
   - Check that game state is 'quest'

3. **Wrong player is marked as leader**
   - Verify leaderIndex matches player position
   - Check player order hasn't changed

---

## Version
- Phase: 2.1
- Completion: ~95% (core logic done, UI integration pending)
- Date: March 2024
