/**
 * Shared RoomManager singleton accessor.
 *
 * index.ts creates the RoomManager and calls setSharedRoomManager().
 * Bot handlers (Discord, LINE) call getSharedRoomManager() to create/join rooms
 * without needing a Socket.IO connection.
 */

import { RoomManager } from './RoomManager';

let instance: RoomManager | null = null;

export function setSharedRoomManager(rm: RoomManager): void {
  instance = rm;
}

export function getSharedRoomManager(): RoomManager {
  if (!instance) {
    throw new Error('RoomManager not initialised — call setSharedRoomManager first');
  }
  return instance;
}
