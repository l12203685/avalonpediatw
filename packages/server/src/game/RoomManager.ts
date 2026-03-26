import { Room, Player } from '@avalon/shared';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private readonly ROOM_EXPIRY_TIME = 30 * 60 * 1000; // 30 minutes
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup timer
    this.startCleanupTimer();
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
  }

  public getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  public getRoomCount(): number {
    return this.rooms.size;
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
  }
}
