import { Room, Player } from '@avalon/shared';

const MAX_REPLAYS = 200;

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private replays: Map<string, Room> = new Map();
  private roomPasswords: Map<string, string> = new Map();
  private readonly ROOM_EXPIRY_TIME = 30 * 60 * 1000; // 30 minutes
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Rehydrate rooms from an external source (e.g. Firebase RTD on server restart).
   * Only loads rooms that are not in 'ended' state.
   */
  public rehydrate(rooms: Room[]): number {
    let loaded = 0;
    for (const room of rooms) {
      if (room.state === 'ended') continue;
      this.rooms.set(room.id, room);
      loaded++;
    }
    return loaded;
  }

  public createRoom(roomId: string, hostName: string, hostId: string): Room {
    const room: Room = {
      id: roomId,
      name: `${hostName}'s Game`,
      host: hostId,
      state: 'lobby',
      players: {
        [hostId]: {
          id: hostId,
          name: hostName,
          role: null,
          team: null,
          status: 'active',
          createdAt: Date.now(),
        },
      },
      maxPlayers: 10,
      currentRound: 0,
      maxRounds: 5,
      votes: {},
      questTeam: [],
      questResults: [],
      failCount: 0,
      evilWins: null,
      leaderIndex: 0,
      voteHistory: [],
      questHistory: [],
      questVotedCount: 0,
      roleOptions: {
        percival: true,
        morgana: true,
        oberon: false,
        mordred: false,
      },
      readyPlayerIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    return room;
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public deleteRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.roomPasswords.delete(roomId);
  }

  /**
   * Save a snapshot of a completed room as a replay record.
   */
  public saveReplay(room: Room): void {
    // Evict oldest entry if at capacity
    if (this.replays.size >= MAX_REPLAYS) {
      const oldestKey = this.replays.keys().next().value;
      if (oldestKey) this.replays.delete(oldestKey);
    }
    this.replays.set(room.id, { ...room });
  }

  public getReplay(roomId: string): Room | undefined {
    return this.replays.get(roomId);
  }

  public getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  public getRoomCount(): number {
    return this.rooms.size;
  }

  public setRoomPassword(roomId: string, password: string | null): void {
    if (password) {
      this.roomPasswords.set(roomId, password);
      const room = this.rooms.get(roomId);
      if (room) room.isPrivate = true;
    } else {
      this.roomPasswords.delete(roomId);
      const room = this.rooms.get(roomId);
      if (room) room.isPrivate = false;
    }
  }

  public checkRoomPassword(roomId: string, password?: string): boolean {
    const stored = this.roomPasswords.get(roomId);
    if (!stored) return true; // no password set
    return stored === password;
  }

  public updateRoom(roomId: string, room: Partial<Room>): Room | undefined {
    const existingRoom = this.rooms.get(roomId);
    if (!existingRoom) return undefined;

    const updated = {
      ...existingRoom,
      ...room,
      id: existingRoom.id, // Prevent ID change
      updatedAt: Date.now(),
    };

    this.rooms.set(roomId, updated);
    return updated;
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredRooms();
    }, 5 * 60 * 1000);
  }

  private cleanupExpiredRooms(): void {
    const now = Date.now();
    const roomsToDelete: string[] = [];
    let deletedCount = 0;

    this.rooms.forEach((room, roomId) => {
      // Delete rooms that are:
      // 1. In ended state and older than expiry time
      // 2. In lobby state with only disconnected players and older than expiry time
      if (room.state === 'ended' && now - room.updatedAt > this.ROOM_EXPIRY_TIME) {
        roomsToDelete.push(roomId);
      } else if (
        room.state === 'lobby' &&
        now - room.createdAt > this.ROOM_EXPIRY_TIME * 2 // 1 hour for empty lobbies
      ) {
        const allDisconnected = Object.values(room.players).every(
          (p) => p.status === 'disconnected'
        );
        if (allDisconnected) {
          roomsToDelete.push(roomId);
        }
      }
    });

    roomsToDelete.forEach((roomId) => {
      this.rooms.delete(roomId);
      this.roomPasswords.delete(roomId);
      deletedCount++;
    });

    if (deletedCount > 0) {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'rooms_cleanup',
        deletedCount,
        remainingRooms: this.rooms.size
      }));
    }
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.rooms.clear();
    this.roomPasswords.clear();
  }
}
