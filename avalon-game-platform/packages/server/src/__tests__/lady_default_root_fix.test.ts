/**
 * Lady of the Lake — default starting holder root fix verification.
 *
 * Edward 2026-04-25 16:52 P0「預設起始湖是 0 家但是開始遊戲後還是隨機」
 *
 * Root fix: server `resolveLadyStartIndex()` must default to `seat0`
 * semantics (= playerIds[playerCount-1]) when `roleOptions.ladyStart`
 * is unset, instead of falling back to random. This matches the lobby
 * UI's visual default `?? 'seat0'` so a host who never opens the
 * dropdown gets the canonical 0家 start.
 *
 * Random is now opt-in only — host must explicitly select "隨機".
 */
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../game/GameEngine';
import { RoomManager } from '../game/RoomManager';

function buildRoom(playerCount: number) {
  const rm = new RoomManager();
  const room = rm.createRoom('r-' + playerCount, 'Host', 'p1');
  for (let i = 2; i <= playerCount; i++) {
    room.players['p' + i] = {
      id: 'p' + i,
      name: 'P' + i,
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    };
  }
  return room;
}

describe('Lady default — Edward 2026-04-25 root fix', () => {
  it('unset ladyStart + 10 players → holder is deterministic playerIds[playerCount-1]', () => {
    for (let trial = 0; trial < 20; trial++) {
      const room = buildRoom(10);
      room.roleOptions = { ...room.roleOptions!, ladyOfTheLake: true };
      // ladyStart intentionally NOT set — this is the bug case
      const engine = new GameEngine(room);
      engine.startGame();
      const playerIds = Object.keys(room.players);
      const expectedHolder = playerIds[playerIds.length - 1];
      expect(room.ladyOfTheLakeHolder).toBe(expectedHolder);
      engine.cleanup();
    }
  });

  it('unset ladyStart + 7/8/9/10 players → holder is always last seat', () => {
    for (const count of [7, 8, 9, 10]) {
      const room = buildRoom(count);
      room.roleOptions = { ...room.roleOptions!, ladyOfTheLake: true };
      const engine = new GameEngine(room);
      engine.startGame();
      const playerIds = Object.keys(room.players);
      expect(room.ladyOfTheLakeHolder).toBe(playerIds[count - 1]);
      engine.cleanup();
    }
  });

  it('explicit ladyStart=random → still distributes across seats over 50 trials', () => {
    const holders = new Set<string>();
    for (let trial = 0; trial < 50; trial++) {
      const room = buildRoom(10);
      room.roleOptions = { ...room.roleOptions!, ladyOfTheLake: true };
      (room.roleOptions as unknown as Record<string, string>).ladyStart = 'random';
      const engine = new GameEngine(room);
      engine.startGame();
      holders.add(room.ladyOfTheLakeHolder!);
      engine.cleanup();
    }
    // 50 trials × 10 seats — should hit ≥ 3 distinct holders by birthday-paradox
    expect(holders.size).toBeGreaterThanOrEqual(3);
  });

  it('explicit ladyStart=seat0 → identical to default (last seat)', () => {
    const room = buildRoom(10);
    room.roleOptions = { ...room.roleOptions!, ladyOfTheLake: true };
    (room.roleOptions as unknown as Record<string, string>).ladyStart = 'seat0';
    const engine = new GameEngine(room);
    engine.startGame();
    const playerIds = Object.keys(room.players);
    expect(room.ladyOfTheLakeHolder).toBe(playerIds[9]);
    engine.cleanup();
  });

  it('explicit ladyStart=seat5 → playerIds[4] (1-based UI mapping)', () => {
    const room = buildRoom(10);
    room.roleOptions = { ...room.roleOptions!, ladyOfTheLake: true };
    (room.roleOptions as unknown as Record<string, string>).ladyStart = 'seat5';
    const engine = new GameEngine(room);
    engine.startGame();
    const playerIds = Object.keys(room.players);
    expect(room.ladyOfTheLakeHolder).toBe(playerIds[4]);
    engine.cleanup();
  });
});
