/**
 * Lady-of-the-Lake records → observation fields (S1-9b / S1-9c, 2026-10-14;
 * docs/ai/logic_first.md). Shared by `GameServer.buildBotObservation` and
 * `SelfPlayEngine` so the live bot and self-play see exactly the same thing.
 *
 *   - `publicLakeHistory`: what every seat may see — declared lakes with their
 *     claim, and lakes whose phase ended without a declaration as
 *     `declaredClaim: 'none'`. The pending lake (inspected, declaration still
 *     open: the last record while the room is in `lady_of_the_lake`) is left
 *     out so the holder's intermediate state stays private. Never the
 *     private `result`.
 *   - `privateLakeResults`: what `playerId` itself saw as holder (the
 *     engine's `result`, which shows Mordred and Oberon red and Merlin good)
 *     — for that player's own observation only.
 */

import type { LadyOfTheLakeRecord, Room } from '@avalon/shared';
import type { LakePublicRecord, PrivateLakeResult } from './types';

type LakeRoom = Pick<Room, 'ladyOfTheLakeHistory' | 'state'>;

/** Public lake records (declared + finished-undeclared as 'none'; pending hidden). */
export function publicLakeHistory(room: LakeRoom): LakePublicRecord[] {
  const records: readonly LadyOfTheLakeRecord[] = room.ladyOfTheLakeHistory ?? [];
  const out: LakePublicRecord[] = [];
  records.forEach((rec, i) => {
    const declared = rec.declared === true && (rec.declaredClaim === 'good' || rec.declaredClaim === 'evil');
    if (!declared) {
      // Still pending: the latest inspection while the lake phase is open.
      const pending = i === records.length - 1 && room.state === 'lady_of_the_lake';
      if (pending) return;
    }
    out.push({
      round: rec.round,
      holderId: rec.holderId,
      targetId: rec.targetId,
      declaredClaim: declared ? (rec.declaredClaim as 'good' | 'evil') : 'none',
    });
  });
  return out;
}

/** `playerId`'s own lake results (private to that player). */
export function privateLakeResults(room: LakeRoom, playerId: string): PrivateLakeResult[] {
  return (room.ladyOfTheLakeHistory ?? [])
    .filter((rec) => rec.holderId === playerId && (rec.result === 'good' || rec.result === 'evil'))
    .map((rec) => ({ round: rec.round, targetId: rec.targetId, result: rec.result }));
}
